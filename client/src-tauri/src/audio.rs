use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering},
    mpsc, Arc, Mutex,
};

/// A device the user asked for was skipped and the system default is used instead.
/// Written to the app log (visible in the in-app log viewer), not only to stderr.
fn warn_device_fallback(message: String) {
    eprintln!("Neyra audio: {message}");
    if let Ok(root) = crate::storage::data_root() {
        crate::logs::log(&root, "warn", &message);
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct AudioDevices {
    pub input_devices: Vec<String>,
    pub output_devices: Vec<String>,
    pub default_input: Option<String>,
    pub default_output: Option<String>,
}

pub fn list_audio_devices() -> AudioDevices {
    let host = cpal::default_host();
    let mut input_devices = Vec::new();
    let mut output_devices = Vec::new();

    if let Ok(devices) = host.input_devices() {
        for dev in devices {
            if let Ok(name) = dev.name() {
                if !input_devices.contains(&name) {
                    input_devices.push(name);
                }
            }
        }
    }

    if let Ok(devices) = host.output_devices() {
        for dev in devices {
            if let Ok(name) = dev.name() {
                if !output_devices.contains(&name) {
                    output_devices.push(name);
                }
            }
        }
    }

    let default_input = host.default_input_device().and_then(|d| d.name().ok());
    let default_output = host.default_output_device().and_then(|d| d.name().ok());

    AudioDevices {
        input_devices,
        output_devices,
        default_input,
        default_output,
    }
}

/// Pure selector logic for choosing an input device and config with fallback to default.
pub fn select_input_device<D, C>(
    requested: Option<&str>,
    available: impl IntoIterator<Item = (D, String)>,
    get_config: impl Fn(&D) -> Result<C, String>,
    get_default: impl FnOnce() -> Option<D>,
) -> Result<(D, C), String> {
    let target = requested.map(|s| s.trim()).filter(|s| !s.is_empty());
    if let Some(name) = target {
        let mut chosen = None;
        for (dev, dev_name) in available {
            if dev_name == name {
                chosen = Some(dev);
                break;
            }
        }
        if let Some(dev) = chosen {
            match get_config(&dev) {
                Ok(cfg) => return Ok((dev, cfg)),
                Err(err) => {
                    eprintln!(
                        "Neyra audio: выбранный микрофон недоступен ({err}), fallback на системный"
                    );
                }
            }
        } else {
            eprintln!("Neyra audio: выбранный микрофон '{name}' не найден, fallback на системный");
        }
    }
    if let Some(def_dev) = get_default() {
        match get_config(&def_dev) {
            Ok(cfg) => Ok((def_dev, cfg)),
            Err(_) => Err("Микрофон недоступен".into()),
        }
    } else {
        Err("Микрофон не найден".into())
    }
}

pub fn open_input_device(
    name: Option<&str>,
) -> Result<(cpal::Device, cpal::SupportedStreamConfig), String> {
    let host = cpal::default_host();
    let mut available = Vec::new();
    if let Ok(devices) = host.input_devices() {
        for dev in devices {
            if let Ok(dev_name) = dev.name() {
                available.push((dev, dev_name));
            }
        }
    }
    let requested = name
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let (device, config) = select_input_device(
        requested.as_deref(),
        available,
        |dev| dev.default_input_config().map_err(|e| e.to_string()),
        || host.default_input_device(),
    )?;
    if let Some(requested) = requested {
        // A name mismatch means select_input_device fell back to the system default.
        let fell_back = device.name().map(|n| n != requested).unwrap_or(true);
        if fell_back {
            warn_device_fallback(format!(
                "выбранный микрофон '{requested}' недоступен, используется системное устройство"
            ));
        }
    }
    Ok((device, config))
}

/// An opened output stream plus the reason the requested device was not used.
pub struct OpenedOutput {
    pub stream: rodio::OutputStream,
    pub handle: rodio::OutputStreamHandle,
    /// The device the user asked for that could not be used; playback fell back
    /// to the system default. `None` when the requested device (or no preference)
    /// was honoured.
    pub fallback_from: Option<String>,
}

/// The human-readable reason playback fell back to the system device (AR-18).
fn fallback_message(requested: &str, seen: bool) -> String {
    format!(
        "выбранное устройство вывода '{requested}' {}, используется системное",
        if seen {
            "недоступно"
        } else {
            "не найдено"
        }
    )
}

pub fn open_output_stream(name: Option<&str>) -> Option<OpenedOutput> {
    let mut fallback_from = None;
    if let Some(target) = name {
        let trimmed = target.trim();
        if !trimmed.is_empty() {
            let host = cpal::default_host();
            let mut saw_name = false;
            if let Ok(devices) = host.output_devices() {
                for dev in devices {
                    if let Ok(dev_name) = dev.name() {
                        if dev_name == trimmed {
                            saw_name = true;
                            if let Ok((stream, handle)) = rodio::OutputStream::try_from_device(&dev)
                            {
                                return Some(OpenedOutput {
                                    stream,
                                    handle,
                                    fallback_from: None,
                                });
                            }
                        }
                    }
                }
            }
            fallback_from = Some(trimmed.to_string());
            warn_device_fallback(fallback_message(trimmed, saw_name));
        }
    }
    let (stream, handle) = rodio::OutputStream::try_default().ok()?;
    Some(OpenedOutput {
        stream,
        handle,
        fallback_from,
    })
}

pub struct Recording {
    stop: mpsc::Sender<()>,
    join: std::thread::JoinHandle<Result<Vec<u8>, String>>,
    /// Latest input level, dBFS × 10, for the recording waveform.
    pub level: Arc<AtomicI32>,
    pub meter_stop: Arc<AtomicBool>,
}

fn note_level(level: &AtomicI32, data: &[f32]) {
    if data.is_empty() {
        return;
    }
    let energy = data.iter().map(|sample| sample * sample).sum::<f32>() / data.len() as f32;
    let db = 10.0 * energy.max(1e-10).log10();
    level.store((db * 10.0) as i32, Ordering::Relaxed);
}
impl Recording {
    pub fn start(device_name: Option<&str>) -> Result<Self, String> {
        let (stop, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<(), String>>(1);
        let level = Arc::new(AtomicI32::new(-1000));
        let meter_stop = Arc::new(AtomicBool::new(false));
        let level_thread = level.clone();
        let target_name = device_name.map(|s| s.to_string());
        let join = std::thread::spawn(move || {
            let opened = (|| -> Result<_, String> {
                let (device, config) = open_input_device(target_name.as_deref())?;
                let channels = config.channels() as usize;
                let rate = config.sample_rate().0;
                let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
                let max = rate as usize * channels * 30;
                let build = |samples: Arc<Mutex<Vec<f32>>>, level: Arc<AtomicI32>| {
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        note_level(&level, data);
                        if let Ok(mut out) = samples.lock() {
                            let left = max.saturating_sub(out.len());
                            out.extend(data.iter().take(left));
                        }
                    }
                };
                let stream = match config.sample_format() {
                    cpal::SampleFormat::F32 => device.build_input_stream(
                        &config.clone().into(),
                        build(samples.clone(), level_thread.clone()),
                        |_| {},
                        None,
                    ),
                    cpal::SampleFormat::I16 => {
                        let s = samples.clone();
                        let level = level_thread.clone();
                        device.build_input_stream(
                            &config.clone().into(),
                            move |data: &[i16], _| {
                                let floats: Vec<f32> =
                                    data.iter().map(|v| *v as f32 / 32768.0).collect();
                                note_level(&level, &floats);
                                if let Ok(mut out) = s.lock() {
                                    let left = max.saturating_sub(out.len());
                                    out.extend(floats.into_iter().take(left));
                                }
                            },
                            |_| {},
                            None,
                        )
                    }
                    cpal::SampleFormat::U16 => {
                        let s = samples.clone();
                        let level = level_thread.clone();
                        device.build_input_stream(
                            &config.clone().into(),
                            move |data: &[u16], _| {
                                let floats: Vec<f32> = data
                                    .iter()
                                    .map(|v| (*v as f32 - 32768.0) / 32768.0)
                                    .collect();
                                note_level(&level, &floats);
                                if let Ok(mut out) = s.lock() {
                                    let left = max.saturating_sub(out.len());
                                    out.extend(floats.into_iter().take(left));
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
                Ok((stream, samples, channels, rate))
            })();

            let (stream, samples, channels, rate) = match opened {
                Ok(res) => {
                    let _ = ready_tx.send(Ok(()));
                    res
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e.to_string()));
                    return Err(e);
                }
            };

            let _ = rx.recv_timeout(std::time::Duration::from_secs(30));
            drop(stream);
            let data = samples.lock().map_err(|_| "Ошибка аудиобуфера")?;
            Ok(resample(&data, channels, rate))
        });
        match ready_rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(Self {
                stop,
                join,
                level,
                meter_stop,
            }),
            Ok(Err(e)) => {
                let _ = stop.send(());
                Err(e)
            }
            Err(_) => {
                let _ = stop.send(());
                Err("Микрофон недоступен: проверьте разрешение ОС".into())
            }
        }
    }
    pub fn finish(self) -> Result<Vec<u8>, String> {
        self.meter_stop.store(true, Ordering::Relaxed);
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

/// 16 kHz mono PCM s16le wrapped so the chat can play the same clip that was sent.
pub fn wav_s16le_16k(pcm: &[u8]) -> Vec<u8> {
    let data_len = u32::try_from(pcm.len()).unwrap_or(u32::MAX);
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&36u32.saturating_add(data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&16_000u32.to_le_bytes());
    wav.extend_from_slice(&32_000u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}

/// Continuous microphone for live mode: 20 ms frames at 16 kHz mono over a bounded channel.
/// Frames are dropped (and counted) when the consumer falls behind; capture never blocks.
pub struct LiveCapture {
    stop: mpsc::Sender<()>,
    pub dropped: Arc<AtomicU64>,
}
impl LiveCapture {
    pub fn start(
        frames: mpsc::SyncSender<Vec<i16>>,
        device_name: Option<&str>,
    ) -> Result<Self, String> {
        let (stop, rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let dropped = Arc::new(AtomicU64::new(0));
        let lost = dropped.clone();
        let target_name = device_name.map(|s| s.to_string());
        std::thread::spawn(move || {
            let opened = (|| -> Result<_, String> {
                let (device, config) = open_input_device(target_name.as_deref())?;
                let resampler = Arc::new(Mutex::new(crate::voice::Resampler::new(
                    config.sample_rate().0,
                    config.channels() as usize,
                )));
                let deliver = move |samples: &[f32]| {
                    let Ok(mut r) = resampler.lock() else { return };
                    for frame in r.push(samples) {
                        if frames.try_send(frame).is_err() {
                            lost.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                };
                let stream_config: cpal::StreamConfig = config.clone().into();
                let stream = match config.sample_format() {
                    cpal::SampleFormat::F32 => device.build_input_stream(
                        &stream_config,
                        move |data: &[f32], _: &cpal::InputCallbackInfo| deliver(data),
                        |_| {},
                        None,
                    ),
                    cpal::SampleFormat::I16 => device.build_input_stream(
                        &stream_config,
                        move |data: &[i16], _: &cpal::InputCallbackInfo| {
                            let v: Vec<f32> = data.iter().map(|s| *s as f32 / 32768.0).collect();
                            deliver(&v)
                        },
                        |_| {},
                        None,
                    ),
                    cpal::SampleFormat::U16 => device.build_input_stream(
                        &stream_config,
                        move |data: &[u16], _: &cpal::InputCallbackInfo| {
                            let v: Vec<f32> = data
                                .iter()
                                .map(|s| (*s as f32 - 32768.0) / 32768.0)
                                .collect();
                            deliver(&v)
                        },
                        |_| {},
                        None,
                    ),
                    _ => return Err("Формат микрофона не поддерживается".into()),
                }
                .map_err(|_| "Не удалось открыть микрофон".to_string())?;
                stream
                    .play()
                    .map_err(|_| "Не удалось включить микрофон".to_string())?;
                Ok(stream)
            })();
            match opened {
                Ok(stream) => {
                    let _ = ready_tx.send(Ok(()));
                    let _ = rx.recv();
                    drop(stream);
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e.to_string()));
                }
            }
        });
        match ready_rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(Self { stop, dropped }),
            Ok(Err(e)) => Err(e),
            Err(_) => {
                let _ = stop.send(());
                Err("Микрофон недоступен: проверьте разрешение ОС".into())
            }
        }
    }
}
impl Drop for LiveCapture {
    fn drop(&mut self) {
        let _ = self.stop.send(());
    }
}

pub enum PlayerEvent {
    Started,
    Played(u64),
    Finished,
    Error(&'static str),
}

enum Command {
    Segment(u64, u64, Vec<u8>),
    Done(u64),
}

/// Re-creates a sink on a (possibly new) device and re-appends every phrase that is
/// queued or playing, so switching the output device mid-reply loses no audio.
/// The current phrase restarts from its beginning on the new device.
fn rebuild_sink(
    handle: &rodio::OutputStreamHandle,
    inflight: &std::collections::VecDeque<(u64, Vec<u8>)>,
) -> Option<rodio::Sink> {
    let sink = rodio::Sink::try_new(handle).ok()?;
    for (_, bytes) in inflight {
        if let Ok(source) = rodio::Decoder::new(std::io::Cursor::new(bytes.clone())) {
            sink.append(source);
        }
    }
    Some(sink)
}

/// Sequential playback of reply segments. A newer `generation` (Stop, barge-in) drops
/// everything queued or playing. At most `QUEUE` segments wait; more is a protocol error.
pub struct Player {
    tx: mpsc::SyncSender<Command>,
    pub playing: Arc<std::sync::atomic::AtomicBool>,
}
const QUEUE: usize = 8;
impl Player {
    pub fn start(
        generation: Arc<AtomicU64>,
        output_device: Arc<Mutex<String>>,
        notify: impl Fn(PlayerEvent) + Send + 'static,
    ) -> Self {
        let (tx, rx) = mpsc::sync_channel::<Command>(QUEUE);
        let playing = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = playing.clone();
        std::thread::spawn(move || {
            let mut output: Option<OpenedOutput> = None;
            let mut last_dev: Option<String> = None;
            let mut sink: Option<rodio::Sink> = None;
            let mut owner = 0u64;
            let mut queued: std::collections::VecDeque<u64> = Default::default();
            // Audio bytes behind every `queued` seq: lets a device switch carry the
            // already queued (and the currently playing) phrases to the new device.
            let mut inflight: std::collections::VecDeque<(u64, Vec<u8>)> = Default::default();
            // Requested device names whose fallback notice was already shown.
            let mut fallback_reported: Option<String> = None;
            let mut done = false;
            loop {
                let current = generation.load(Ordering::SeqCst);
                if owner != current {
                    if let Some(s) = sink.take() {
                        s.stop();
                    }
                    queued.clear();
                    inflight.clear();
                    done = false;
                    owner = current;
                    flag.store(false, Ordering::SeqCst);
                }
                if let Some(s) = &sink {
                    while queued.len() > s.len() {
                        if let Some(seq) = queued.pop_front() {
                            inflight.pop_front();
                            notify(PlayerEvent::Played(seq));
                        }
                    }
                    if done && s.empty() {
                        sink = None;
                        done = false;
                        flag.store(false, Ordering::SeqCst);
                        notify(PlayerEvent::Finished);
                    }
                }
                let command = match rx.recv_timeout(std::time::Duration::from_millis(20)) {
                    Ok(c) => c,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };
                match command {
                    Command::Segment(gen, seq, bytes) if gen == owner => {
                        let current_dev = output_device.lock().ok().and_then(|d| {
                            let trimmed = d.trim().to_string();
                            if trimmed.is_empty() {
                                None
                            } else {
                                Some(trimmed)
                            }
                        });
                        if output.is_none() || last_dev != current_dev {
                            let device_changed = sink.is_some() && last_dev != current_dev;
                            let reopened = open_output_stream(current_dev.as_deref());
                            if let Some(from) =
                                reopened.as_ref().and_then(|o| o.fallback_from.clone())
                            {
                                if fallback_reported.as_deref() != Some(from.as_str()) {
                                    fallback_reported = Some(from);
                                    // A distinct code so the UI can say "switched to the system
                                    // device" instead of a generic audio failure (AR-18).
                                    notify(PlayerEvent::Error("audio_fallback"));
                                }
                            }
                            sink = None;
                            output = reopened;
                            last_dev = current_dev.clone();
                            if device_changed {
                                // Carry the queued phrases over instead of dropping them.
                                if let Some(opened) = &output {
                                    sink = rebuild_sink(&opened.handle, &inflight);
                                }
                            }
                        }
                        let Some(opened) = &output else {
                            notify(PlayerEvent::Error("audio_unavailable"));
                            continue;
                        };
                        if sink.is_none() {
                            sink = rebuild_sink(&opened.handle, &inflight);
                            if sink.is_none() && current_dev.is_some() {
                                warn_device_fallback(
                                    "устройство вывода отключено или недоступно, \
                                     используется системное"
                                        .into(),
                                );
                                output = rodio::OutputStream::try_default().ok().map(
                                    |(stream, handle)| OpenedOutput {
                                        stream,
                                        handle,
                                        fallback_from: None,
                                    },
                                );
                                if let Some(opened) = &output {
                                    sink = rebuild_sink(&opened.handle, &inflight);
                                }
                            }
                            if sink.is_some() {
                                flag.store(true, Ordering::SeqCst);
                                notify(PlayerEvent::Started);
                            }
                        }
                        let (Some(s), Ok(source)) = (
                            &sink,
                            rodio::Decoder::new(std::io::Cursor::new(bytes.clone())),
                        ) else {
                            notify(PlayerEvent::Error("audio_invalid"));
                            continue;
                        };
                        s.append(source);
                        queued.push_back(seq);
                        inflight.push_back((seq, bytes));
                    }
                    Command::Done(gen) if gen == owner => {
                        if sink.is_none() {
                            notify(PlayerEvent::Finished);
                        } else {
                            done = true;
                        }
                    }
                    _ => {}
                }
            }
        });
        Self { tx, playing }
    }
    pub fn segment(&self, generation: u64, seq: u64, bytes: Vec<u8>) -> Result<(), &'static str> {
        self.tx
            .try_send(Command::Segment(generation, seq, bytes))
            .map_err(|_| "audio_backpressure")
    }
    pub fn done(&self, generation: u64) {
        // The player drains every 20 ms, so this waits at most one tick.
        let _ = self.tx.send(Command::Done(generation));
    }
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
    #[test]
    fn wav_header_names_16k_mono() {
        let wav = wav_s16le_16k(&[1, 2, 3, 4]);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
        assert_eq!(wav.len(), 48);
        assert_eq!(&wav[44..], &[1, 2, 3, 4]);
    }
    #[test]
    fn wav_header_empty_data() {
        let wav = wav_s16le_16k(&[]);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()), 36);
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 0);
        assert_eq!(wav.len(), 44);
    }
    #[test]
    fn resample_empty_or_zero_rate() {
        assert!(resample(&[], 1, 16000).is_empty());
        assert!(resample(&[0.5; 100], 0, 16000).is_empty());
        assert!(resample(&[0.5; 100], 1, 0).is_empty());
    }
    #[test]
    fn select_input_device_chosen_success() {
        let available = vec![(1, "USB Mic".to_string()), (2, "Default Mic".to_string())];
        let cfg_fn = |dev: &i32| match dev {
            1 => Ok("48kHz"),
            2 => Ok("44.1kHz"),
            _ => Err("unknown".into()),
        };
        let res = select_input_device(Some("USB Mic"), available, cfg_fn, || Some(2));
        let (dev, cfg) = res.unwrap();
        assert_eq!(dev, 1);
        assert_eq!(cfg, "48kHz");
    }
    #[test]
    fn select_input_device_chosen_unavailable_fallback() {
        let available = vec![(1, "USB Mic".to_string()), (2, "Default Mic".to_string())];
        let cfg_fn = |dev: &i32| match dev {
            1 => Err("device busy".into()),
            2 => Ok("44.1kHz"),
            _ => Err("unknown".into()),
        };
        let res = select_input_device(Some("USB Mic"), available, cfg_fn, || Some(2));
        let (dev, cfg) = res.unwrap();
        // When chosen device fails default_input_config, must return default
        // device (2), not chosen (1)!
        assert_eq!(dev, 2);
        assert_eq!(cfg, "44.1kHz");
    }
    #[test]
    fn select_input_device_chosen_not_found_fallback() {
        let available = vec![(2, "Default Mic".to_string())];
        let cfg_fn = |dev: &i32| match dev {
            2 => Ok("44.1kHz"),
            _ => Err("unknown".into()),
        };
        let res = select_input_device(Some("Disconnected Mic"), available, cfg_fn, || Some(2));
        let (dev, cfg) = res.unwrap();
        assert_eq!(dev, 2);
        assert_eq!(cfg, "44.1kHz");
    }
    #[test]
    fn select_input_device_none_or_empty_returns_default() {
        let available = vec![(2, "Default Mic".to_string())];
        let cfg_fn = |_: &i32| Ok("44.1kHz");
        let res1 = select_input_device(None, available.clone(), cfg_fn, || Some(2));
        let (dev1, cfg1) = res1.unwrap();
        assert_eq!(dev1, 2);
        assert_eq!(cfg1, "44.1kHz");

        let res2 = select_input_device(Some("   "), available, cfg_fn, || Some(2));
        let (dev2, cfg2) = res2.unwrap();
        assert_eq!(dev2, 2);
        assert_eq!(cfg2, "44.1kHz");
    }
    #[test]
    fn select_input_device_both_fail_returns_error() {
        let available = vec![(1, "USB Mic".to_string()), (2, "Default Mic".to_string())];
        let err_fn = |_: &i32| -> Result<&'static str, String> { Err("busy".into()) };
        let res = select_input_device(Some("USB Mic"), available, err_fn, || Some(2));
        let err = res.unwrap_err();
        assert_eq!(err, "Микрофон недоступен");
    }
    #[test]
    fn select_input_device_no_default_returns_not_found() {
        let available: Vec<(i32, String)> = vec![];
        let cfg_fn = |_: &i32| Ok("48kHz");
        let res = select_input_device(Some("USB Mic"), available, cfg_fn, || None);
        let err = res.unwrap_err();
        assert_eq!(err, "Микрофон не найден");
    }
    #[test]
    fn select_input_device_duplicate_names_picks_first() {
        let available = vec![
            (1, "Generic Mic".to_string()),
            (2, "Generic Mic".to_string()),
        ];
        let cfg_fn = |dev: &i32| match dev {
            1 => Ok("48kHz"),
            2 => Ok("16kHz"),
            _ => Err("unknown".into()),
        };
        let res = select_input_device(Some("Generic Mic"), available, cfg_fn, || Some(3));
        let (dev, cfg) = res.unwrap();
        assert_eq!(dev, 1);
        assert_eq!(cfg, "48kHz");
    }
    #[test]
    fn open_input_device_safe_without_panic() {
        // Calling open_input_device directly must never panic on any environment,
        // returning either Ok((dev, cfg)) or Err(message).
        let _ = open_input_device(Some("Nonexistent Mic"));
        let _ = open_input_device(None);
    }

    #[test]
    fn fallback_message_names_the_reason() {
        // AR-18: a fallback must be explainable to the user, and "not found" must be
        // distinguishable from "found but unavailable". The message is pure, so this
        // test never opens a real output stream: creating a WASAPI stream on a headless
        // Windows runner kills the whole test binary.
        assert_eq!(
            fallback_message("Neyra Missing Output XYZ", false),
            "выбранное устройство вывода 'Neyra Missing Output XYZ' не найдено, используется системное"
        );
        assert_eq!(
            fallback_message("Speakers", true),
            "выбранное устройство вывода 'Speakers' недоступно, используется системное"
        );
    }
}
