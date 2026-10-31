//! Live voice logic without devices: settings, VAD, the send gate, resampling, segment order.
//!
//! The gate is the only place that decides when microphone audio may leave the PC.
//! In wake mode nothing is sent until the local detector fires.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

pub const RATE: usize = 16_000;
pub const FRAME: usize = 320; // 20 ms at 16 kHz
const PREROLL_FRAMES: usize = 15; // 300 ms before speech start
const START_FRAMES: usize = 3; // 60 ms of speech opens an utterance
const MIN_SPEECH_FRAMES: usize = 15; // shorter bursts are false starts
const MAX_UTTERANCE_FRAMES: usize = 28 * RATE / FRAME; // server limit is 30 s
const WAKE_WINDOW_FRAMES: usize = 4 * RATE / FRAME; // time to start the command after the wake word
const SEND_BYTES: usize = 3200; // 100 ms per network frame

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct VoiceSettings {
    /// ptt | wake | always
    pub mode: String,
    /// 0.0 (needs loud speech) ..= 1.0 (reacts to quiet speech)
    pub vad_sensitivity: f32,
    /// End of phrase after this much silence.
    pub end_silence_ms: u32,
    /// 0.0 ..= 1.0, wake model score that counts as "Нейра".
    pub wake_threshold: f32,
    /// off: the mic is muted while Neyra speaks (half-duplex, no echo cancellation).
    /// headphones: voice barge-in while Neyra speaks; only safe without speakers.
    pub barge_in: String,
}
impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            mode: "ptt".into(),
            vad_sensitivity: 0.5,
            end_silence_ms: 700,
            wake_threshold: 0.5,
            barge_in: "off".into(),
        }
    }
}
impl VoiceSettings {
    pub fn validate(&self) -> Result<(), String> {
        if !matches!(self.mode.as_str(), "ptt" | "wake" | "always")
            || !matches!(self.barge_in.as_str(), "off" | "headphones")
            || !(0.0..=1.0).contains(&self.vad_sensitivity)
            || !(0.05..=0.99).contains(&self.wake_threshold)
            || !(300..=2000).contains(&self.end_silence_ms)
        {
            return Err("Неверные настройки голоса".into());
        }
        Ok(())
    }
}

/// Energy VAD with an adaptive noise floor. Not a neural model; sensitivity is user-tuned.
pub struct Vad {
    floor_db: f32,
    margin_db: f32,
}
impl Vad {
    pub fn new(sensitivity: f32) -> Self {
        Self {
            floor_db: -60.0,
            margin_db: 18.0 - 12.0 * sensitivity.clamp(0.0, 1.0),
        }
    }
    pub fn level_db(frame: &[i16]) -> f32 {
        if frame.is_empty() {
            return -100.0;
        }
        let energy = frame
            .iter()
            .map(|s| (*s as f32 / 32768.0).powi(2))
            .sum::<f32>()
            / frame.len() as f32;
        10.0 * energy.max(1e-10).log10()
    }
    pub fn is_speech(&mut self, frame: &[i16]) -> bool {
        let db = Self::level_db(frame);
        let speech = db > -50.0 && db > self.floor_db + self.margin_db;
        if !speech {
            // Fast down, slow up: the floor follows the room, not the voice.
            let rate = if db < self.floor_db { 0.2 } else { 0.02 };
            self.floor_db += (db - self.floor_db) * rate;
            self.floor_db = self.floor_db.clamp(-90.0, -20.0);
        }
        speech
    }
}

#[derive(Debug, PartialEq)]
pub enum Action {
    /// The local wake word fired. No audio has been sent.
    Wake,
    /// A phrase starts: open an utterance on the server (barge-in if a turn is running).
    Begin,
    /// PCM s16le mono 16 kHz.
    Audio(Vec<u8>),
    /// End of phrase.
    Commit,
    /// Too short to be speech: drop it on the server.
    Cancel,
    /// Wake window ran out without a command.
    WakeExpired,
}

#[derive(Debug, PartialEq, Clone, Copy)]
enum State {
    Idle,
    Armed(usize),
    Speaking,
}

pub struct Gate {
    wake_mode: bool,
    barge_in: bool,
    end_frames: usize,
    vad: Vad,
    state: State,
    preroll: VecDeque<Vec<i16>>,
    run: usize,
    speech: usize,
    silence: usize,
    length: usize,
    out: Vec<u8>,
}
impl Gate {
    pub fn new(settings: &VoiceSettings) -> Self {
        Self {
            wake_mode: settings.mode == "wake",
            barge_in: settings.barge_in == "headphones",
            end_frames: (settings.end_silence_ms as usize * RATE / 1000 / FRAME).max(1),
            vad: Vad::new(settings.vad_sensitivity),
            state: State::Idle,
            preroll: VecDeque::new(),
            run: 0,
            speech: 0,
            silence: 0,
            length: 0,
            out: Vec::new(),
        }
    }
    pub fn is_sending(&self) -> bool {
        self.state == State::Speaking
    }
    /// Waiting for the wake word (wake mode) or for speech (always mode).
    pub fn is_idle(&self) -> bool {
        self.state == State::Idle
    }
    /// One 20 ms frame. `wake` is the local detector verdict, `playing` is Neyra speaking.
    pub fn push(&mut self, frame: &[i16], wake: bool, playing: bool) -> Vec<Action> {
        let mut actions = Vec::new();
        if playing && !self.barge_in {
            // Half-duplex: the mic hears the speakers, so nothing is detected or sent.
            if self.state == State::Speaking {
                actions.push(Action::Cancel);
            }
            self.reset();
            return actions;
        }
        let speech = self.vad.is_speech(frame);
        match self.state {
            State::Idle if self.wake_mode => {
                if wake {
                    // Audio before the wake word never leaves the PC.
                    self.preroll.clear();
                    self.run = 0;
                    self.state = State::Armed(WAKE_WINDOW_FRAMES);
                    actions.push(Action::Wake);
                }
            }
            State::Idle | State::Armed(_) => {
                self.remember(frame);
                self.run = if speech { self.run + 1 } else { 0 };
                if self.run >= START_FRAMES {
                    self.state = State::Speaking;
                    self.speech = self.run;
                    self.silence = 0;
                    self.length = self.preroll.len();
                    actions.push(Action::Begin);
                    for f in std::mem::take(&mut self.preroll) {
                        self.out.extend(f.iter().flat_map(|s| s.to_le_bytes()));
                    }
                    self.flush(&mut actions, true);
                } else if let State::Armed(left) = self.state {
                    if left <= 1 {
                        self.reset();
                        actions.push(Action::WakeExpired);
                    } else {
                        self.state = State::Armed(left - 1);
                    }
                }
            }
            State::Speaking => {
                self.out.extend(frame.iter().flat_map(|s| s.to_le_bytes()));
                self.length += 1;
                if speech {
                    self.speech += 1;
                    self.silence = 0;
                } else {
                    self.silence += 1;
                }
                if self.silence >= self.end_frames || self.length >= MAX_UTTERANCE_FRAMES {
                    if self.speech >= MIN_SPEECH_FRAMES {
                        self.flush(&mut actions, true);
                        actions.push(Action::Commit);
                    } else {
                        self.out.clear();
                        actions.push(Action::Cancel);
                    }
                    self.reset();
                } else {
                    self.flush(&mut actions, false);
                }
            }
        }
        actions
    }
    fn remember(&mut self, frame: &[i16]) {
        self.preroll.push_back(frame.to_vec());
        while self.preroll.len() > PREROLL_FRAMES {
            self.preroll.pop_front();
        }
    }
    fn flush(&mut self, actions: &mut Vec<Action>, all: bool) {
        if !self.out.is_empty() && (all || self.out.len() >= SEND_BYTES) {
            actions.push(Action::Audio(std::mem::take(&mut self.out)));
        }
    }
    fn reset(&mut self) {
        self.state = State::Idle;
        self.preroll.clear();
        self.out.clear();
        self.run = 0;
        self.speech = 0;
        self.silence = 0;
        self.length = 0;
    }
}

/// Streaming linear resampler: any device rate and channel count to 16 kHz mono.
pub struct Resampler {
    channels: usize,
    step: f64,
    pos: f64,
    prev: f32,
    pending: Vec<i16>,
}
impl Resampler {
    pub fn new(rate: u32, channels: usize) -> Self {
        Self {
            channels: channels.max(1),
            step: rate.max(1) as f64 / RATE as f64,
            pos: 0.0,
            prev: 0.0,
            pending: Vec::new(),
        }
    }
    /// Feed interleaved samples, get complete 20 ms frames.
    pub fn push(&mut self, interleaved: &[f32]) -> Vec<Vec<i16>> {
        let mono: Vec<f32> = interleaved
            .chunks(self.channels)
            .map(|c| c.iter().sum::<f32>() / c.len() as f32)
            .collect();
        // Position is relative to `prev` (index -1) followed by `mono`.
        while self.pos < mono.len() as f64 {
            let i = self.pos.floor();
            let frac = (self.pos - i) as f32;
            let a = if i < 1.0 {
                self.prev
            } else {
                mono[i as usize - 1]
            };
            let b = mono[i as usize];
            let v = (a + (b - a) * frac).clamp(-1.0, 1.0);
            self.pending.push((v * 32767.0) as i16);
            self.pos += self.step;
        }
        self.pos -= mono.len() as f64;
        if let Some(last) = mono.last() {
            self.prev = *last;
        }
        let mut frames = Vec::new();
        while self.pending.len() >= FRAME {
            frames.push(self.pending.drain(..FRAME).collect());
        }
        frames
    }
}

/// Live reply audio arrives as numbered segments. Anything out of order is a late packet.
#[derive(Default)]
pub struct Segments {
    request: Option<String>,
    expected: u64,
    buffer: Vec<u8>,
}
pub const MAX_SEGMENT_BYTES: usize = 8 * 1024 * 1024;
impl Segments {
    pub fn request(&self) -> Option<String> {
        self.request.clone()
    }
    pub fn reset(&mut self, request: Option<String>) {
        self.request = request;
        self.expected = 0;
        self.buffer.clear();
    }
    /// A chunk of segment `seq`. Returns false if it must be dropped.
    pub fn chunk(&mut self, request: &str, seq: Option<u64>, data: &[u8]) -> bool {
        if self.request.as_deref() != Some(request) {
            self.reset(Some(request.into()));
        }
        if seq.is_some_and(|s| s != self.expected)
            || self.buffer.len() + data.len() > MAX_SEGMENT_BYTES
        {
            return false;
        }
        self.buffer.extend_from_slice(data);
        true
    }
    /// Segment `seq` is complete. Returns its audio, or None for a late/duplicate segment.
    pub fn finish(&mut self, request: &str, seq: Option<u64>) -> Option<(u64, Vec<u8>)> {
        if self.request.as_deref() != Some(request) {
            return None;
        }
        if seq.is_some_and(|s| s != self.expected) || self.buffer.is_empty() {
            return None;
        }
        let number = self.expected;
        self.expected += 1;
        Some((number, std::mem::take(&mut self.buffer)))
    }
}

/// Wake score -> single trigger, with a refractory time so one "Нейра" fires once.
pub struct WakeTrigger {
    threshold: f32,
    cooldown: usize,
    left: usize,
}
impl WakeTrigger {
    pub fn new(threshold: f32) -> Self {
        Self {
            threshold,
            cooldown: 25, // 25 scores x 80 ms = 2 s
            left: 0,
        }
    }
    pub fn push(&mut self, score: f32) -> bool {
        if self.left > 0 {
            self.left -= 1;
            return false;
        }
        if score >= self.threshold {
            self.left = self.cooldown;
            return true;
        }
        false
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// Synthetic fixtures: a voiced vowel-like tone, room noise, and silence.
    pub fn tone(frames: usize, amplitude: f32) -> Vec<Vec<i16>> {
        (0..frames)
            .map(|f| {
                (0..FRAME)
                    .map(|i| {
                        let t = (f * FRAME + i) as f32 / RATE as f32;
                        let v = (t * 220.0 * std::f32::consts::TAU).sin() * 0.6
                            + (t * 440.0 * std::f32::consts::TAU).sin() * 0.3;
                        (v * amplitude * 32767.0) as i16
                    })
                    .collect()
            })
            .collect()
    }
    pub fn noise(frames: usize, amplitude: f32) -> Vec<Vec<i16>> {
        let mut seed = 0x2545_f491_u32;
        (0..frames)
            .map(|_| {
                (0..FRAME)
                    .map(|_| {
                        seed ^= seed << 13;
                        seed ^= seed >> 17;
                        seed ^= seed << 5;
                        let v = (seed as f32 / u32::MAX as f32) * 2.0 - 1.0;
                        (v * amplitude * 32767.0) as i16
                    })
                    .collect()
            })
            .collect()
    }

    fn settings(mode: &str) -> VoiceSettings {
        VoiceSettings {
            mode: mode.into(),
            ..VoiceSettings::default()
        }
    }
    fn run(
        gate: &mut Gate,
        frames: &[Vec<i16>],
        wake_at: Option<usize>,
        playing: bool,
    ) -> Vec<Action> {
        frames
            .iter()
            .enumerate()
            .flat_map(|(i, f)| gate.push(f, wake_at == Some(i), playing))
            .collect()
    }
    fn sent_bytes(actions: &[Action]) -> usize {
        actions
            .iter()
            .map(|a| match a {
                Action::Audio(b) => b.len(),
                _ => 0,
            })
            .sum()
    }

    #[test]
    fn always_mode_sends_phrase_and_commits_after_silence() {
        let mut gate = Gate::new(&settings("always"));
        let mut actions = run(&mut gate, &noise(50, 0.002), None, false);
        assert!(actions.is_empty(), "room noise must not open the mic");
        actions = run(&mut gate, &tone(40, 0.3), None, false);
        actions.extend(run(&mut gate, &noise(40, 0.002), None, false));
        assert_eq!(actions.first(), Some(&Action::Begin));
        assert_eq!(actions.last(), Some(&Action::Commit));
        assert!(sent_bytes(&actions) >= 40 * FRAME * 2);
        assert!(
            actions
                .iter()
                .filter(|a| matches!(a, Action::Audio(_)))
                .count()
                > 2
        );
    }

    #[test]
    fn short_click_is_cancelled_not_committed() {
        let mut gate = Gate::new(&settings("always"));
        run(&mut gate, &noise(30, 0.002), None, false);
        let mut actions = run(&mut gate, &tone(5, 0.4), None, false);
        actions.extend(run(&mut gate, &noise(40, 0.002), None, false));
        assert!(actions.contains(&Action::Begin));
        assert_eq!(actions.last(), Some(&Action::Cancel));
        assert!(!actions.contains(&Action::Commit));
    }

    #[test]
    fn wake_mode_sends_nothing_before_the_wake_word() {
        let mut gate = Gate::new(&settings("wake"));
        // Loud speech without the wake word: never leaves the PC.
        let actions = run(&mut gate, &tone(200, 0.4), None, false);
        assert!(actions.is_empty());
        assert!(!gate.is_sending());
    }

    #[test]
    fn wake_then_command_sends_only_audio_after_wake() {
        let mut gate = Gate::new(&settings("wake"));
        let before = tone(30, 0.4);
        let mut actions = run(&mut gate, &before, Some(29), false);
        assert_eq!(actions, vec![Action::Wake]);
        actions = run(&mut gate, &noise(10, 0.002), None, false);
        actions.extend(run(&mut gate, &tone(30, 0.3), None, false));
        actions.extend(run(&mut gate, &noise(40, 0.002), None, false));
        assert_eq!(actions.first(), Some(&Action::Begin));
        assert_eq!(actions.last(), Some(&Action::Commit));
        // Pre-roll after the wake word only: at most 10 quiet frames + the command.
        assert!(sent_bytes(&actions) <= (10 + 30 + 40) * FRAME * 2);
    }

    #[test]
    fn wake_window_expires_without_command() {
        let mut gate = Gate::new(&settings("wake"));
        run(&mut gate, &noise(5, 0.002), Some(4), false);
        let actions = run(
            &mut gate,
            &noise(WAKE_WINDOW_FRAMES + 5, 0.002),
            None,
            false,
        );
        assert_eq!(actions, vec![Action::WakeExpired]);
        assert!(run(&mut gate, &tone(50, 0.4), None, false).is_empty());
    }

    #[test]
    fn half_duplex_mutes_mic_while_neyra_speaks() {
        let mut gate = Gate::new(&settings("always"));
        let actions = run(&mut gate, &tone(100, 0.4), None, true);
        assert!(actions.is_empty(), "speaker echo must not become a phrase");
        // An utterance that was open when playback started is dropped, not sent.
        let mut gate = Gate::new(&settings("always"));
        run(&mut gate, &noise(20, 0.002), None, false);
        run(&mut gate, &tone(10, 0.4), None, false);
        assert!(gate.is_sending());
        assert_eq!(
            run(&mut gate, &tone(1, 0.4), None, true),
            vec![Action::Cancel]
        );
    }

    #[test]
    fn headphones_mode_allows_voice_barge_in_during_playback() {
        let mut s = settings("always");
        s.barge_in = "headphones".into();
        let mut gate = Gate::new(&s);
        run(&mut gate, &noise(20, 0.002), None, true);
        let actions = run(&mut gate, &tone(10, 0.4), None, true);
        assert_eq!(actions.first(), Some(&Action::Begin));
    }

    #[test]
    fn long_phrase_is_committed_before_server_limit() {
        let mut gate = Gate::new(&settings("always"));
        let actions = run(
            &mut gate,
            &tone(MAX_UTTERANCE_FRAMES + 10, 0.3),
            None,
            false,
        );
        assert!(actions.contains(&Action::Commit));
        assert!(sent_bytes(&actions) <= 30 * RATE * 2);
    }

    #[test]
    fn resampler_48k_stereo_gives_20ms_frames() {
        let mut r = Resampler::new(48_000, 2);
        let mut frames = Vec::new();
        for _ in 0..10 {
            frames.extend(r.push(&vec![0.25; 4800 * 2]));
        }
        // 10 x 100 ms = 1 s = 50 frames.
        assert!((49..=50).contains(&frames.len()));
        assert!(frames.iter().all(|f| f.len() == FRAME));
        assert_eq!(frames[10][100], (0.25f32 * 32767.0) as i16);
    }

    #[test]
    fn segments_drop_late_and_out_of_order_audio() {
        let mut s = Segments::default();
        assert!(s.chunk("a", Some(0), b"one"));
        assert!(!s.chunk("a", Some(2), b"late"));
        assert_eq!(s.finish("a", Some(0)), Some((0, b"one".to_vec())));
        assert_eq!(s.finish("a", Some(0)), None, "duplicate segment");
        assert!(s.chunk("b", Some(0), b"new turn"));
        assert_eq!(s.finish("a", Some(1)), None, "old turn");
        assert_eq!(s.finish("b", Some(0)), Some((0, b"new turn".to_vec())));
        assert!(!s.chunk("b", Some(1), &vec![0; MAX_SEGMENT_BYTES + 1]));
    }

    #[test]
    fn wake_trigger_fires_once_per_word() {
        // Synthetic score fixtures: a positive burst and near-threshold negatives.
        let positive = [0.1, 0.3, 0.7, 0.9, 0.8, 0.6, 0.2];
        let negative = [0.2, 0.45, 0.49, 0.3, 0.1];
        let mut t = WakeTrigger::new(0.5);
        assert_eq!(positive.iter().filter(|s| t.push(**s)).count(), 1);
        let mut t = WakeTrigger::new(0.5);
        assert_eq!(negative.iter().filter(|s| t.push(**s)).count(), 0);
    }

    #[test]
    fn voice_settings_reject_unknown_values() {
        assert!(VoiceSettings::default().validate().is_ok());
        for bad in [
            VoiceSettings {
                mode: "telepathy".into(),
                ..Default::default()
            },
            VoiceSettings {
                barge_in: "speakers".into(),
                ..Default::default()
            },
            VoiceSettings {
                vad_sensitivity: 2.0,
                ..Default::default()
            },
        ] {
            assert!(bad.validate().is_err());
        }
    }
}
