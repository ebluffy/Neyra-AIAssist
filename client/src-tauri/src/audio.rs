use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    mpsc, Arc, Mutex,
};

pub struct Recording {
    stop: mpsc::Sender<()>,
    join: std::thread::JoinHandle<Result<Vec<u8>, String>>,
}
impl Recording {
    pub fn start() -> Result<Self, String> {
        let (stop, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let join = std::thread::spawn(move || {
            let device = cpal::default_host()
                .default_input_device()
                .ok_or("Микрофон не найден")?;
            let config = device
                .default_input_config()
                .map_err(|_| "Микрофон недоступен")?;
            let channels = config.channels() as usize;
            let rate = config.sample_rate().0;
            let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
            let max = rate as usize * channels * 30;
            let build = |samples: Arc<Mutex<Vec<f32>>>| {
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if let Ok(mut out) = samples.lock() {
                        let left = max.saturating_sub(out.len());
                        out.extend(data.iter().take(left));
                    }
                }
            };
            let stream = match config.sample_format() {
                cpal::SampleFormat::F32 => device.build_input_stream(
                    &config.clone().into(),
                    build(samples.clone()),
                    |_| {},
                    None,
                ),
                cpal::SampleFormat::I16 => {
                    let s = samples.clone();
                    device.build_input_stream(
                        &config.clone().into(),
                        move |data: &[i16], _| {
                            if let Ok(mut out) = s.lock() {
                                let left = max.saturating_sub(out.len());
                                out.extend(data.iter().take(left).map(|v| *v as f32 / 32768.0));
                            }
                        },
                        |_| {},
                        None,
                    )
                }
                cpal::SampleFormat::U16 => {
                    let s = samples.clone();
                    device.build_input_stream(
                        &config.clone().into(),
                        move |data: &[u16], _| {
                            if let Ok(mut out) = s.lock() {
                                let left = max.saturating_sub(out.len());
                                out.extend(
                                    data.iter()
                                        .take(left)
                                        .map(|v| (*v as f32 - 32768.0) / 32768.0),
                                );
                            }
                        },
                        |_| {},
                        None,
                    )
                }
                _ => return Err("Формат микрофона не поддерживается".into()),
            }
            .map_err(|_| "Не удалось открыть микрофон")?;
            stream.play().map_err(|_| "Не удалось включить микрофон")?;
            let _ = ready_tx.send(());
            let _ = rx.recv_timeout(std::time::Duration::from_secs(30));
            drop(stream);
            let data = samples.lock().map_err(|_| "Ошибка аудиобуфера")?;
            Ok(resample(&data, channels, rate))
        });
        if ready_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .is_err()
        {
            let _ = stop.send(());
            return Err("Микрофон недоступен: проверьте разрешение ОС".into());
        }
        Ok(Self { stop, join })
    }
    pub fn finish(self) -> Result<Vec<u8>, String> {
        let _ = self.stop.send(());
        self.join.join().map_err(|_| "Ошибка записи")?
    }
}

pub fn resample(samples: &[f32], channels: usize, rate: u32) -> Vec<u8> {
    if channels == 0 || rate == 0 {
        return vec![];
    }
    let count = samples.len() / channels;
    let frames = count * 16000 / rate as usize;
    let mut out = Vec::with_capacity(frames * 2);
    for frame in 0..frames {
        let pos = frame as f64 * rate as f64 / 16000.0;
        let i = pos.floor() as usize;
        let frac = (pos - i as f64) as f32;
        let mono = |n: usize| {
            samples[n * channels..(n + 1) * channels]
                .iter()
                .sum::<f32>()
                / channels as f32
        };
        let a = mono(i.min(count - 1));
        let b = mono((i + 1).min(count - 1));
        let v = ((a + (b - a) * frac).clamp(-1.0, 1.0) * 32767.0) as i16;
        out.extend(v.to_le_bytes());
    }
    out
}

pub fn play(
    bytes: Vec<u8>,
    generation: Arc<AtomicU64>,
    notify: impl Fn(&str) + Send + 'static,
) -> Result<(), String> {
    let mine = generation.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        let Ok((_stream, handle)) = rodio::OutputStream::try_default() else {
            notify("audio_unavailable");
            return;
        };
        let Ok(sink) = rodio::Sink::try_new(&handle) else {
            notify("audio_unavailable");
            return;
        };
        let Ok(source) = rodio::Decoder::new(std::io::Cursor::new(bytes)) else {
            notify("audio_invalid");
            return;
        };
        sink.append(source);
        while !sink.empty() && generation.load(Ordering::SeqCst) == mine {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        sink.stop();
        notify("audio_finished");
    });
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resample_48k_stereo_to_16k_mono() {
        let audio = vec![0.5; 48000 * 2];
        let result = resample(&audio, 2, 48000);
        assert_eq!(result.len(), 32000);
        assert_eq!(i16::from_le_bytes([result[0], result[1]]), 16383);
    }
}
