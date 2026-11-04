//! Local wake word "Нейра" with openWakeWord models, run by tract (pure Rust, no network).
//!
//! Files live in `Documents/Neyra/wakeword/`:
//! `melspectrogram.onnx`, `embedding_model.onnx` (openWakeWord feature models),
//! the custom classifier named in `wakeword.json`, and `wakeword.json` itself.
//! Nothing is bundled and nothing is downloaded. English pretrained models are refused.

use serde::Deserialize;
use std::{collections::VecDeque, path::Path};
use tract_onnx::prelude::*;

const CHUNK: usize = 1280; // 80 ms: one embedding step
const CONTEXT: usize = 480; // 3 x 160 samples of mel context
const MEL_BINS: usize = 32;
const MEL_WINDOW: usize = 76;
const EMBEDDING: usize = 96;
const MAX_MODEL_BYTES: u64 = 16 * 1024 * 1024;
/// Stock openWakeWord English models. They do not detect "Нейра" and must not pose as it.
const ENGLISH_PRETRAINED: [&str; 6] = [
    "alexa",
    "hey_jarvis",
    "hey_mycroft",
    "hey_rhasspy",
    "timer",
    "weather",
];

type Plan = std::sync::Arc<TypedRunnableModel>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub phrase: String,
    pub language: String,
    pub model: String,
    pub license: String,
    pub source: String,
}

pub fn check_manifest(dir: &Path) -> Result<Manifest, String> {
    let raw = std::fs::read(dir.join("wakeword.json"))
        .map_err(|_| "Нет wakeword.json в папке wakeword".to_string())?;
    let m: Manifest =
        serde_json::from_slice(&raw).map_err(|_| "wakeword.json повреждён".to_string())?;
    let file = Path::new(&m.model);
    let name = m.model.to_lowercase();
    if m.schema_version != 1
        || m.phrase.trim().to_lowercase() != "нейра"
        || m.language != "ru"
        || file.file_name().map(|f| f.to_string_lossy().to_string()) != Some(m.model.clone())
        || !name.ends_with(".onnx")
        || matches!(
            name.as_str(),
            "melspectrogram.onnx" | "embedding_model.onnx"
        )
    {
        return Err("wakeword.json: нужна русская модель «Нейра» (phrase, language, model)".into());
    }
    if ENGLISH_PRETRAINED.iter().any(|p| name.starts_with(p)) {
        return Err("Это английская модель openWakeWord, она не распознаёт «Нейра»".into());
    }
    if m.license.trim().is_empty() || m.source.trim().is_empty() {
        return Err("wakeword.json: укажите license и source модели".into());
    }
    Ok(m)
}

fn load(path: &Path, shape: &[usize]) -> Result<Plan, String> {
    let size = std::fs::metadata(path)
        .map_err(|_| format!("Нет файла {}", path.display()))?
        .len();
    if size > MAX_MODEL_BYTES {
        return Err(format!("Слишком большой файл {}", path.display()));
    }
    tract_onnx::onnx()
        .model_for_path(path)
        .and_then(|m| m.with_input_fact(0, f32::fact(shape).into()))
        .and_then(|m| m.into_optimized())
        .and_then(|m| m.into_runnable())
        .map_err(|_| format!("Модель не загрузилась: {}", path.display()))
}

pub struct Detector {
    mel: Plan,
    embed: Plan,
    classify: Plan,
    frames: usize,
    raw: VecDeque<f32>,
    fresh: usize,
    mel_buffer: VecDeque<[f32; MEL_BINS]>,
    features: VecDeque<[f32; EMBEDDING]>,
}
impl Detector {
    pub fn open(dir: &Path) -> Result<Self, String> {
        let manifest = check_manifest(dir)?;
        Self::from_files(
            &dir.join("melspectrogram.onnx"),
            &dir.join("embedding_model.onnx"),
            &dir.join(&manifest.model),
        )
    }
    pub fn from_files(mel: &Path, embed: &Path, classifier: &Path) -> Result<Self, String> {
        let mel = load(mel, &[1, CHUNK + CONTEXT])?;
        let embed = load(embed, &[1, MEL_WINDOW, MEL_BINS, 1])?;
        // Classifier input is [1, frames, 96]; frames comes from the model (16 for openWakeWord).
        let mut frames = 0;
        for candidate in [16usize, 8, 12, 20, 24, 32] {
            if let Ok(plan) = load(classifier, &[1, candidate, EMBEDDING]) {
                let input =
                    Tensor::zero::<f32>(&[1, candidate, EMBEDDING]).map_err(|e| e.to_string())?;
                if plan.run(tvec!(input.into())).is_ok() {
                    frames = candidate;
                    break;
                }
            }
        }
        if frames == 0 {
            return Err("Классификатор wake word не совместим с openWakeWord".into());
        }
        let classify = load(classifier, &[1, frames, EMBEDDING])?;
        Ok(Self {
            mel,
            embed,
            classify,
            frames,
            raw: VecDeque::from(vec![0.0; CONTEXT]),
            fresh: 0,
            mel_buffer: VecDeque::from(vec![[1.0; MEL_BINS]; MEL_WINDOW]),
            features: VecDeque::new(),
        })
    }
    /// Feed 16 kHz PCM. Returns one score per completed 80 ms step.
    pub fn push(&mut self, pcm: &[i16]) -> Result<Vec<f32>, String> {
        let mut scores = Vec::new();
        for sample in pcm {
            // openWakeWord feeds int16 values as float, not normalised.
            self.raw.push_back(*sample as f32);
            self.fresh += 1;
            if self.fresh == CHUNK {
                self.fresh = 0;
                while self.raw.len() > CHUNK + CONTEXT {
                    self.raw.pop_front();
                }
                if let Some(score) = self.step()? {
                    scores.push(score);
                }
            }
        }
        Ok(scores)
    }
    fn step(&mut self) -> Result<Option<f32>, String> {
        let samples: Vec<f32> = self.raw.iter().copied().collect();
        let mel = infer(&self.mel, &[1, samples.len()], &samples)?;
        for row in mel.as_chunks::<MEL_BINS>().0 {
            let mut bins = [0.0; MEL_BINS];
            for (b, v) in bins.iter_mut().zip(row) {
                *b = v / 10.0 + 2.0;
            }
            self.mel_buffer.push_back(bins);
        }
        while self.mel_buffer.len() > MEL_WINDOW {
            self.mel_buffer.pop_front();
        }
        let window: Vec<f32> = self.mel_buffer.iter().flatten().copied().collect();
        let values = infer(&self.embed, &[1, MEL_WINDOW, MEL_BINS, 1], &window)?;
        let mut embedding = [0.0; EMBEDDING];
        for (e, v) in embedding.iter_mut().zip(values) {
            *e = v;
        }
        self.features.push_back(embedding);
        while self.features.len() > self.frames {
            self.features.pop_front();
        }
        if self.features.len() < self.frames {
            return Ok(None);
        }
        let flat: Vec<f32> = self.features.iter().flatten().copied().collect();
        let score = infer(&self.classify, &[1, self.frames, EMBEDDING], &flat)?;
        Ok(score.first().map(|s| s.clamp(0.0, 1.0)))
    }
}

fn infer(plan: &Plan, shape: &[usize], data: &[f32]) -> Result<Vec<f32>, String> {
    let input = Tensor::from_shape(shape, data).map_err(|e| e.to_string())?;
    let out = plan.run(tvec!(input.into())).map_err(|e| e.to_string())?;
    let first = out.first().ok_or("Пустой ответ модели")?;
    first
        .try_as_plain_ram()
        .and_then(|view| view.as_slice::<f32>().map(<[f32]>::to_vec))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest_dir(body: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("wakeword.json"), body).unwrap();
        dir
    }

    #[test]
    fn manifest_requires_russian_neyra_model_with_license() {
        let ok = manifest_dir(
            r#"{"schema_version":1,"phrase":"Нейра","language":"ru","model":"neyra_v1.onnx","license":"Apache-2.0","source":"own synthetic training"}"#,
        );
        assert_eq!(check_manifest(&ok).unwrap().model, "neyra_v1.onnx");
        for bad in [
            r#"{"schema_version":1,"phrase":"Нейра","language":"ru","model":"hey_jarvis_v0.1.onnx","license":"CC","source":"oww"}"#,
            r#"{"schema_version":1,"phrase":"Hey Jarvis","language":"en","model":"neyra.onnx","license":"x","source":"y"}"#,
            r#"{"schema_version":1,"phrase":"Нейра","language":"ru","model":"../neyra.onnx","license":"x","source":"y"}"#,
            r#"{"schema_version":1,"phrase":"Нейра","language":"ru","model":"embedding_model.onnx","license":"x","source":"y"}"#,
            r#"{"schema_version":1,"phrase":"Нейра","language":"ru","model":"neyra.onnx","license":"","source":"y"}"#,
        ] {
            assert!(check_manifest(&manifest_dir(bad)).is_err(), "{bad}");
        }
        assert!(Detector::open(&std::env::temp_dir().join("absent-neyra-wakeword")).is_err());
    }

    /// Runs only with real openWakeWord files: NEYRA_OWW_DIR with melspectrogram.onnx,
    /// embedding_model.onnx and any classifier named classifier.onnx.
    #[test]
    fn pipeline_scores_synthetic_audio_with_real_models() {
        let Ok(dir) = std::env::var("NEYRA_OWW_DIR") else {
            return;
        };
        let dir = Path::new(&dir);
        let mut d = Detector::from_files(
            &dir.join("melspectrogram.onnx"),
            &dir.join("embedding_model.onnx"),
            &dir.join("classifier.onnx"),
        )
        .unwrap();
        let silence = vec![0i16; 16000 * 3];
        let scores = d.push(&silence).unwrap();
        // 3 s = 37 steps; the first 15 fill the classifier window.
        assert_eq!(scores.len(), 37 - d.frames + 1);
        assert!(scores.iter().all(|s| (0.0..=1.0).contains(s)));
        assert!(
            scores.iter().all(|s| *s < 0.5),
            "silence is not a wake word"
        );
        // Parity check against the Python openWakeWord reference: clip.pcm in, scores out.
        if let Ok(raw) = std::fs::read(dir.join("clip.pcm")) {
            let pcm: Vec<i16> = raw
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| i16::from_le_bytes(*b))
                .collect();
            let mut d = Detector::from_files(
                &dir.join("melspectrogram.onnx"),
                &dir.join("embedding_model.onnx"),
                &dir.join("classifier.onnx"),
            )
            .unwrap();
            let scores: Vec<String> = d
                .push(&pcm)
                .unwrap()
                .iter()
                .map(|s| s.to_string())
                .collect();
            std::fs::write(dir.join("rust_scores.txt"), scores.join("\n")).unwrap();
        }
    }
}
