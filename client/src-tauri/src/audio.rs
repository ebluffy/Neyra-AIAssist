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

/// Continuous microphone for live mode: 20 ms frames at 16 kHz mono over a bounded channel.
/// Frames are dropped (and counted) when the consumer falls behind; capture never blocks.
pub struct LiveCapture {
    stop: mpsc::Sender<()>,
    pub dropped: Arc<AtomicU64>,
}
impl LiveCapture {
    pub fn start(frames: mpsc::SyncSender<Vec<i16>>) -> Result<Self, String> {
        let (stop, rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let dropped = Arc::new(AtomicU64::new(0));
        let lost = dropped.clone();
        std::thread::spawn(move || {
            let opened = (|| {
                let device = cpal::default_host()
                    .default_input_device()
                    .ok_or("Микрофон не найден")?;
                let config = device
                    .default_input_config()
                    .map_err(|_| "Микрофон недоступен")?;
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
                    _ => return Err("Формат микрофона не поддерживается"),
                }
                .map_err(|_| "Не удалось открыть микрофон")?;
                stream.play().map_err(|_| "Не удалось включить микрофон")?;
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
        notify: impl Fn(PlayerEvent) + Send + 'static,
    ) -> Self {
        let (tx, rx) = mpsc::sync_channel::<Command>(QUEUE);
        let playing = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = playing.clone();
        std::thread::spawn(move || {
            let mut output: Option<(rodio::OutputStream, rodio::OutputStreamHandle)> = None;
            let mut sink: Option<rodio::Sink> = None;
            let mut owner = 0u64;
            let mut queued: std::collections::VecDeque<u64> = Default::default();
            let mut done = false;
            loop {
                let current = generation.load(Ordering::SeqCst);
                if owner != current {
                    if let Some(s) = sink.take() {
                        s.stop();
                    }
                    queued.clear();
                    done = false;
                    owner = current;
                    flag.store(false, Ordering::SeqCst);
                }
                if let Some(s) = &sink {
                    while queued.len() > s.len() {
                        if let Some(seq) = queued.pop_front() {
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
                        if output.is_none() {
                            output = rodio::OutputStream::try_default().ok();
                        }
                        let Some((_, handle)) = &output else {
                            notify(PlayerEvent::Error("audio_unavailable"));
                            continue;
                        };
                        if sink.is_none() {
                            sink = rodio::Sink::try_new(handle).ok();
                            if sink.is_some() {
                                flag.store(true, Ordering::SeqCst);
                                notify(PlayerEvent::Started);
                            }
                        }
                        let (Some(s), Ok(source)) =
                            (&sink, rodio::Decoder::new(std::io::Cursor::new(bytes)))
                        else {
                            notify(PlayerEvent::Error("audio_invalid"));
                            continue;
                        };
                        s.append(source);
                        queued.push_back(seq);
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
}
