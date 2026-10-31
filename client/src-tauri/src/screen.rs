use base64::Engine;
use serde_json::{json, Map, Value};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

pub const MAX_STEPS: usize = 20;
const MAX_TEXT: usize = 500;
const MAX_TOTAL_TEXT: usize = 2000;
const MAX_WAIT_MS: u64 = 2000;
const SHOT_TTL: Duration = Duration::from_secs(120);
const MAX_IMAGE_SIDE: u32 = 1366;
const STEP_PAUSE: Duration = Duration::from_millis(40);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Raw capture in packed RGB; `area` is the region in the backend's native input coordinates.
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
    pub area: Rect,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Key {
    pub name: &'static str,
    pub keysym: u32,
    pub vk: u16,
    pub modifier: bool,
    pub extended: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    Move {
        x: f64,
        y: f64,
    },
    Click {
        x: f64,
        y: f64,
        button: Button,
        count: u8,
    },
    Drag {
        x: f64,
        y: f64,
        to_x: f64,
        to_y: f64,
    },
    Scroll {
        x: f64,
        y: f64,
        dx: i32,
        dy: i32,
    },
    Type {
        text: String,
    },
    Key {
        keys: Vec<Key>,
    },
    Wait {
        ms: u64,
    },
}

impl Step {
    fn points(&self) -> Vec<(f64, f64)> {
        match self {
            Step::Move { x, y } | Step::Click { x, y, .. } | Step::Scroll { x, y, .. } => {
                vec![(*x, *y)]
            }
            Step::Drag { x, y, to_x, to_y } => vec![(*x, *y), (*to_x, *to_y)],
            _ => vec![],
        }
    }
}

pub trait Backend {
    fn capture(&mut self, window: Option<&str>) -> Result<Frame, String>;
    fn move_to(&mut self, x: f64, y: f64) -> Result<(), String>;
    fn button(&mut self, button: Button, down: bool) -> Result<(), String>;
    fn scroll(&mut self, dx: i32, dy: i32) -> Result<(), String>;
    fn key(&mut self, key: Key, down: bool) -> Result<(), String>;
    fn text(&mut self, text: &str) -> Result<(), String>;
}

const fn key(name: &'static str, keysym: u32, vk: u16) -> Key {
    Key {
        name,
        keysym,
        vk,
        modifier: false,
        extended: false,
    }
}
const fn ext(name: &'static str, keysym: u32, vk: u16) -> Key {
    Key {
        name,
        keysym,
        vk,
        modifier: false,
        extended: true,
    }
}
const fn modifier(name: &'static str, keysym: u32, vk: u16) -> Key {
    Key {
        name,
        keysym,
        vk,
        modifier: true,
        extended: false,
    }
}

/// Allowlisted keys only; keysyms are X11/xkb values, vk are Win32 virtual-key codes.
const NAMED: &[Key] = &[
    modifier("ctrl", 0xffe3, 0x11),
    modifier("shift", 0xffe1, 0x10),
    modifier("alt", 0xffe9, 0x12),
    modifier("meta", 0xffeb, 0x5b),
    key("enter", 0xff0d, 0x0d),
    key("tab", 0xff09, 0x09),
    key("escape", 0xff1b, 0x1b),
    key("backspace", 0xff08, 0x08),
    key("space", 0x0020, 0x20),
    ext("delete", 0xffff, 0x2e),
    ext("insert", 0xff63, 0x2d),
    ext("home", 0xff50, 0x24),
    ext("end", 0xff57, 0x23),
    ext("pageup", 0xff55, 0x21),
    ext("pagedown", 0xff56, 0x22),
    ext("left", 0xff51, 0x25),
    ext("up", 0xff52, 0x26),
    ext("right", 0xff53, 0x27),
    ext("down", 0xff54, 0x28),
];

pub fn key_by_name(name: &str) -> Option<Key> {
    let lower = name.trim().to_ascii_lowercase();
    let alias = match lower.as_str() {
        "control" => "ctrl",
        "return" => "enter",
        "esc" => "escape",
        "del" => "delete",
        "win" | "super" | "cmd" => "meta",
        "pgup" => "pageup",
        "pgdn" => "pagedown",
        other => other,
    };
    if let Some(k) = NAMED.iter().find(|k| k.name == alias) {
        return Some(*k);
    }
    let bytes = alias.as_bytes();
    if bytes.len() == 1 && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit()) {
        let c = bytes[0];
        let vk = c.to_ascii_uppercase() as u16;
        // Static names for the 36 single-character keys.
        const CHARS: &str = "abcdefghijklmnopqrstuvwxyz0123456789";
        let i = CHARS.find(c as char)?;
        return Some(key(&CHARS[i..i + 1], c as u32, vk));
    }
    if let Some(n) = alias.strip_prefix('f').and_then(|n| n.parse::<u16>().ok()) {
        if (1..=12).contains(&n) {
            const F: [&str; 12] = [
                "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
            ];
            return Some(key(F[n as usize - 1], 0xffbd + n as u32, 0x6f + n));
        }
    }
    None
}

fn parse_keys(combo: &str) -> Result<Vec<Key>, String> {
    if combo.len() > 64 {
        return Err("Слишком длинное сочетание".into());
    }
    let keys: Vec<Key> = combo
        .split('+')
        .map(|k| key_by_name(k).ok_or_else(|| format!("Клавиша не разрешена: {k}")))
        .collect::<Result<_, _>>()?;
    let mains = keys.iter().filter(|k| !k.modifier).count();
    if keys.is_empty() || keys.len() > 4 || mains > 1 {
        return Err("Сочетание: модификаторы и одна клавиша".into());
    }
    let has = |n: &str| keys.iter().any(|k| k.name == n);
    if has("ctrl") && has("alt") && has("delete") {
        return Err("Это сочетание не отправляется".into());
    }
    Ok(keys)
}

fn coord(step: &Map<String, Value>, key: &str) -> Result<f64, String> {
    step.get(key)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite() && *v >= 0.0 && *v <= 100_000.0)
        .ok_or_else(|| format!("Неверная координата {key}"))
}

fn small_int(
    step: &Map<String, Value>,
    key: &str,
    range: std::ops::RangeInclusive<i64>,
) -> Result<i64, String> {
    match step.get(key) {
        None => Ok(0),
        Some(v) => v
            .as_i64()
            .filter(|n| range.contains(n))
            .ok_or_else(|| format!("Неверное значение {key}")),
    }
}

/// Validates the full sequence before anything is sent to the OS.
pub fn parse(args: &Map<String, Value>) -> Result<(Option<String>, Vec<Step>), String> {
    let shot = match args.get("screenshot_id") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if uuid::Uuid::parse_str(s).is_ok() => Some(s.clone()),
        _ => return Err("Неверный screenshot_id".into()),
    };
    let raw = args
        .get("steps")
        .and_then(Value::as_array)
        .ok_or("Нужен список шагов")?;
    if raw.is_empty() || raw.len() > MAX_STEPS {
        return Err(format!("От 1 до {MAX_STEPS} шагов"));
    }
    let mut total_text = 0usize;
    let mut steps = Vec::with_capacity(raw.len());
    for item in raw {
        let s = item.as_object().ok_or("Шаг должен быть объектом")?;
        let op = s.get("op").and_then(Value::as_str).ok_or("Нужен op")?;
        let allowed: &[&str] = match op {
            "move" => &["op", "x", "y"],
            "click" => &["op", "x", "y", "button", "count"],
            "drag" => &["op", "x", "y", "to_x", "to_y"],
            "scroll" => &["op", "x", "y", "dx", "dy"],
            "type" => &["op", "text"],
            "key" => &["op", "keys"],
            "wait" => &["op", "ms"],
            _ => return Err(format!("Неизвестный шаг {op}")),
        };
        if s.keys().any(|k| !allowed.contains(&k.as_str())) {
            return Err("Лишние параметры шага".into());
        }
        steps.push(match op {
            "move" => Step::Move {
                x: coord(s, "x")?,
                y: coord(s, "y")?,
            },
            "click" => Step::Click {
                x: coord(s, "x")?,
                y: coord(s, "y")?,
                button: match s.get("button").and_then(Value::as_str).unwrap_or("left") {
                    "left" => Button::Left,
                    "right" => Button::Right,
                    "middle" => Button::Middle,
                    _ => return Err("Неверная кнопка".into()),
                },
                count: small_int(s, "count", 0..=2)?.max(1) as u8,
            },
            "drag" => Step::Drag {
                x: coord(s, "x")?,
                y: coord(s, "y")?,
                to_x: coord(s, "to_x")?,
                to_y: coord(s, "to_y")?,
            },
            "scroll" => {
                let dx = small_int(s, "dx", -10..=10)? as i32;
                let dy = small_int(s, "dy", -10..=10)? as i32;
                if dx == 0 && dy == 0 {
                    return Err("Прокрутка без направления".into());
                }
                Step::Scroll {
                    x: coord(s, "x")?,
                    y: coord(s, "y")?,
                    dx,
                    dy,
                }
            }
            "type" => {
                let text = s.get("text").and_then(Value::as_str).ok_or("Нужен текст")?;
                total_text += text.chars().count();
                if text.is_empty()
                    || text.chars().count() > MAX_TEXT
                    || total_text > MAX_TOTAL_TEXT
                    || text
                        .chars()
                        .any(|c| c.is_control() && c != '\n' && c != '\t')
                {
                    return Err("Неверный или слишком длинный текст".into());
                }
                Step::Type {
                    text: text.to_string(),
                }
            }
            "key" => Step::Key {
                keys: parse_keys(
                    s.get("keys")
                        .and_then(Value::as_str)
                        .ok_or("Нужны клавиши")?,
                )?,
            },
            _ => {
                let ms = s.get("ms").and_then(Value::as_u64).ok_or("Нужна пауза")?;
                if ms > MAX_WAIT_MS {
                    return Err("Пауза не больше 2 секунд".into());
                }
                Step::Wait { ms }
            }
        });
    }
    if shot.is_none() && steps.iter().any(|s| !s.points().is_empty()) {
        return Err("Для мыши нужен screenshot_id свежего снимка".into());
    }
    Ok((shot, steps))
}

pub fn preview(steps: &[Step]) -> String {
    let lines: Vec<String> = steps
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let text = match s {
                Step::Move { x, y } => format!("навести мышь на ({x:.0}, {y:.0})"),
                Step::Click {
                    x,
                    y,
                    button,
                    count,
                } => {
                    let b = match button {
                        Button::Left => "левой",
                        Button::Right => "правой",
                        Button::Middle => "средней",
                    };
                    let times = if *count == 2 { " дважды" } else { "" };
                    format!("клик {b} кнопкой{times} в ({x:.0}, {y:.0})")
                }
                Step::Drag { x, y, to_x, to_y } => {
                    format!("перетащить ({x:.0}, {y:.0}) → ({to_x:.0}, {to_y:.0})")
                }
                Step::Scroll { x, y, dx, dy } => {
                    format!("прокрутка ({dx}, {dy}) в ({x:.0}, {y:.0})")
                }
                Step::Type { text } => format!("ввести текст: «{text}»"),
                Step::Key { keys } => {
                    let names: Vec<&str> = keys.iter().map(|k| k.name).collect();
                    format!("нажать {}", names.join("+"))
                }
                Step::Wait { ms } => format!("пауза {ms} мс"),
            };
            format!("{}. {text}", i + 1)
        })
        .collect();
    format!(
        "Координаты — в пикселях последнего снимка.\n{}",
        lines.join("\n")
    )
}

#[derive(Clone, Debug)]
pub struct Shot {
    pub id: String,
    pub session: String,
    created: Instant,
    pub image_w: u32,
    pub image_h: u32,
    pub area: Rect,
}

static SHOTS: Mutex<VecDeque<Shot>> = Mutex::new(VecDeque::new());

fn remember(shot: Shot) {
    if let Ok(mut shots) = SHOTS.lock() {
        shots.retain(|s| s.created.elapsed() < SHOT_TTL);
        if shots.len() >= 8 {
            shots.pop_front();
        }
        shots.push_back(shot);
    }
}

pub fn forget_all() {
    if let Ok(mut shots) = SHOTS.lock() {
        shots.clear();
    }
}

fn find_shot(id: &str, session: &str) -> Result<Shot, String> {
    let shots = SHOTS.lock().map_err(|_| "Внутренняя ошибка")?;
    shots
        .iter()
        .find(|s| s.id == id && s.session == session && s.created.elapsed() < SHOT_TTL)
        .cloned()
        .ok_or_else(|| "Снимок устарел: сделайте новый скриншот".into())
}

/// Screenshot pixels → native input coordinates (DPI scale and monitor offsets included).
pub fn map_point(shot: &Shot, x: f64, y: f64) -> Result<(f64, f64), String> {
    if x >= shot.image_w as f64 || y >= shot.image_h as f64 {
        return Err("Точка вне снимка".into());
    }
    Ok((
        shot.area.x + (x + 0.5) * shot.area.w / shot.image_w as f64,
        shot.area.y + (y + 0.5) * shot.area.h / shot.image_h as f64,
    ))
}

fn downscale(frame: &Frame) -> (u32, u32, Vec<u8>) {
    let (w, h) = (frame.width.max(1), frame.height.max(1));
    let factor = (w.max(h) as f64 / MAX_IMAGE_SIDE as f64).max(1.0);
    let (dw, dh) = (
        ((w as f64 / factor).round() as u32).max(1),
        ((h as f64 / factor).round() as u32).max(1),
    );
    if dw == w && dh == h {
        return (w, h, frame.rgb.clone());
    }
    let mut out = Vec::with_capacity((dw * dh * 3) as usize);
    for y in 0..dh {
        let y0 = (y as u64 * h as u64 / dh as u64) as u32;
        let y1 = (((y + 1) as u64 * h as u64 / dh as u64) as u32)
            .max(y0 + 1)
            .min(h);
        for x in 0..dw {
            let x0 = (x as u64 * w as u64 / dw as u64) as u32;
            let x1 = (((x + 1) as u64 * w as u64 / dw as u64) as u32)
                .max(x0 + 1)
                .min(w);
            let mut sum = [0u64; 3];
            for sy in y0..y1 {
                let row = (sy * w) as usize * 3;
                for sx in x0..x1 {
                    let i = row + sx as usize * 3;
                    for (total, value) in sum.iter_mut().zip(&frame.rgb[i..i + 3]) {
                        *total += *value as u64;
                    }
                }
            }
            let n = ((y1 - y0) * (x1 - x0)) as u64;
            out.extend(sum.map(|s| (s / n) as u8));
        }
    }
    (dw, dh, out)
}

pub fn capture<B: Backend + ?Sized>(
    backend: &mut B,
    window: Option<&str>,
    session: &str,
) -> Result<Value, String> {
    let frame = backend.capture(window)?;
    if frame.rgb.len() != (frame.width * frame.height * 3) as usize {
        return Err("Неверный кадр".into());
    }
    let (w, h, rgb) = downscale(&frame);
    let mut jpeg = Vec::new();
    jpeg_encoder::Encoder::new(&mut jpeg, 70)
        .encode(&rgb, w as u16, h as u16, jpeg_encoder::ColorType::Rgb)
        .map_err(|_| "Не удалось сжать снимок")?;
    let id = uuid::Uuid::new_v4().to_string();
    remember(Shot {
        id: id.clone(),
        session: session.to_string(),
        created: Instant::now(),
        image_w: w,
        image_h: h,
        area: frame.area,
    });
    Ok(json!({
        "status": "ok",
        "screenshot_id": id,
        "width": w,
        "height": h,
        "mime": "image/jpeg",
        "data": base64::engine::general_purpose::STANDARD.encode(jpeg),
    }))
}

/// Releases anything still held if the sequence stops midway (Stop, error, panic unwind).
struct Held<'a, B: Backend + ?Sized> {
    backend: &'a mut B,
    keys: Vec<Key>,
    buttons: Vec<Button>,
}
impl<B: Backend + ?Sized> Drop for Held<'_, B> {
    fn drop(&mut self) {
        while let Some(k) = self.keys.pop() {
            let _ = self.backend.key(k, false);
        }
        while let Some(b) = self.buttons.pop() {
            let _ = self.backend.button(b, false);
        }
    }
}
impl<B: Backend + ?Sized> Held<'_, B> {
    fn press_key(&mut self, k: Key) -> Result<(), String> {
        self.backend.key(k, true)?;
        self.keys.push(k);
        Ok(())
    }
    fn release_key(&mut self, k: Key) -> Result<(), String> {
        self.keys.retain(|x| *x != k);
        self.backend.key(k, false)
    }
    fn press_button(&mut self, b: Button) -> Result<(), String> {
        self.backend.button(b, true)?;
        self.buttons.push(b);
        Ok(())
    }
    fn release_button(&mut self, b: Button) -> Result<(), String> {
        self.buttons.retain(|x| *x != b);
        self.backend.button(b, false)
    }
}

fn pause(ms: u64, cancel: &AtomicBool) -> bool {
    let until = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < until {
        if cancel.load(Ordering::SeqCst) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    !cancel.load(Ordering::SeqCst)
}

pub fn run<B: Backend + ?Sized>(
    backend: &mut B,
    args: &Map<String, Value>,
    session: &str,
    cancel: &AtomicBool,
) -> Result<Value, String> {
    let (shot_id, steps) = parse(args)?;
    let shot = shot_id.map(|id| find_shot(&id, session)).transpose()?;
    // Map every point first: nothing is sent unless the whole sequence is valid.
    let mut mapped = Vec::with_capacity(steps.len());
    for step in &steps {
        let points = match &shot {
            Some(shot) => step
                .points()
                .into_iter()
                .map(|(x, y)| map_point(shot, x, y))
                .collect::<Result<Vec<_>, _>>()?,
            None => vec![],
        };
        mapped.push(points);
    }
    let mut held = Held {
        backend,
        keys: vec![],
        buttons: vec![],
    };
    let mut done = 0usize;
    for (step, points) in steps.iter().zip(&mapped) {
        if cancel.load(Ordering::SeqCst) {
            return Ok(json!({"status":"cancelled","completed_steps":done}));
        }
        match step {
            Step::Move { .. } => held.backend.move_to(points[0].0, points[0].1)?,
            Step::Click { button, count, .. } => {
                held.backend.move_to(points[0].0, points[0].1)?;
                for _ in 0..*count {
                    held.press_button(*button)?;
                    held.release_button(*button)?;
                }
            }
            Step::Drag { .. } => {
                held.backend.move_to(points[0].0, points[0].1)?;
                held.press_button(Button::Left)?;
                let (sx, sy) = points[0];
                let (ex, ey) = points[1];
                for i in 1..=10 {
                    if !pause(15, cancel) {
                        return Ok(json!({"status":"cancelled","completed_steps":done}));
                    }
                    let t = i as f64 / 10.0;
                    held.backend
                        .move_to(sx + (ex - sx) * t, sy + (ey - sy) * t)?;
                }
                held.release_button(Button::Left)?;
            }
            Step::Scroll { dx, dy, .. } => {
                held.backend.move_to(points[0].0, points[0].1)?;
                held.backend.scroll(*dx, *dy)?;
            }
            Step::Type { text } => {
                for chunk in text.chars().collect::<Vec<_>>().chunks(20) {
                    if cancel.load(Ordering::SeqCst) {
                        return Ok(json!({"status":"cancelled","completed_steps":done}));
                    }
                    held.backend.text(&chunk.iter().collect::<String>())?;
                }
            }
            Step::Key { keys } => {
                for k in keys {
                    held.press_key(*k)?;
                }
                for k in keys.iter().rev() {
                    held.release_key(*k)?;
                }
            }
            Step::Wait { ms } => {
                if !pause(*ms, cancel) {
                    return Ok(json!({"status":"cancelled","completed_steps":done}));
                }
            }
        }
        done += 1;
        if !pause(STEP_PAUSE.as_millis() as u64, cancel) && done < steps.len() {
            return Ok(json!({"status":"cancelled","completed_steps":done}));
        }
    }
    Ok(json!({"status":"ok","completed_steps":done}))
}

// ---------- platform selection ----------

fn session_kind() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if std::env::var("XDG_SESSION_TYPE").unwrap_or_default() == "wayland"
        || std::env::var_os("WAYLAND_DISPLAY").is_some()
    {
        "wayland"
    } else if std::env::var_os("DISPLAY").is_some() {
        "x11"
    } else {
        "none"
    }
}

pub fn screen_available() -> bool {
    match session_kind() {
        "windows" => true,
        #[cfg(target_os = "linux")]
        "x11" => x11::probe().0,
        #[cfg(target_os = "linux")]
        "wayland" => wayland::probe().0,
        _ => false,
    }
}

pub fn input_available() -> bool {
    match session_kind() {
        "windows" => true,
        #[cfg(target_os = "linux")]
        "x11" => x11::probe().1,
        #[cfg(target_os = "linux")]
        "wayland" => wayland::probe().1,
        _ => false,
    }
}

static BACKEND: Mutex<Option<Box<dyn Backend + Send>>> = Mutex::new(None);

pub fn with_backend<R>(f: impl FnOnce(&mut dyn Backend) -> Result<R, String>) -> Result<R, String> {
    let mut slot = BACKEND.lock().map_err(|_| "Внутренняя ошибка")?;
    if slot.is_none() {
        *slot = Some(open_backend()?);
    }
    let backend = slot.as_mut().ok_or("Нет доступа к экрану")?;
    let result = f(backend.as_mut());
    if result.is_err() {
        // A broken display connection or revoked portal session is reopened next time.
        *slot = None;
    }
    result
}

/// Drops portal/X sessions, e.g. when the user turns Contour 4 off.
pub fn reset() {
    if let Ok(mut slot) = BACKEND.lock() {
        *slot = None;
    }
    forget_all();
}

fn open_backend() -> Result<Box<dyn Backend + Send>, String> {
    match session_kind() {
        #[cfg(windows)]
        "windows" => Ok(Box::new(win::Win32::new())),
        #[cfg(target_os = "linux")]
        "x11" => Ok(Box::new(x11::X11::connect()?)),
        #[cfg(target_os = "linux")]
        "wayland" => Ok(Box::new(wayland::Portal::start()?)),
        _ => Err("Экран недоступен в этой сессии".into()),
    }
}

// ---------- Windows: GDI capture + SendInput ----------

#[cfg(windows)]
mod win {
    use super::*;

    #[repr(C)]
    struct BitmapInfoHeader {
        size: u32,
        width: i32,
        height: i32,
        planes: u16,
        bit_count: u16,
        compression: u32,
        size_image: u32,
        x_ppm: i32,
        y_ppm: i32,
        clr_used: u32,
        clr_important: u32,
    }
    #[repr(C)]
    struct BitmapInfo {
        header: BitmapInfoHeader,
        colors: [u32; 3],
    }
    #[repr(C)]
    #[derive(Default)]
    struct WinRect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct MouseInput {
        dx: i32,
        dy: i32,
        data: u32,
        flags: u32,
        time: u32,
        extra: usize,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct KeybdInput {
        vk: u16,
        scan: u16,
        flags: u32,
        time: u32,
        extra: usize,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    union InputUnion {
        mi: MouseInput,
        ki: KeybdInput,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Input {
        kind: u32,
        u: InputUnion,
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetSystemMetrics(index: i32) -> i32;
        fn GetDC(window: isize) -> isize;
        fn ReleaseDC(window: isize, dc: isize) -> i32;
        fn GetWindowRect(window: isize, rect: *mut WinRect) -> i32;
        fn IsWindow(window: isize) -> i32;
        fn SendInput(count: u32, inputs: *const Input, size: i32) -> u32;
    }
    #[link(name = "gdi32")]
    extern "system" {
        fn CreateCompatibleDC(dc: isize) -> isize;
        fn CreateCompatibleBitmap(dc: isize, w: i32, h: i32) -> isize;
        fn SelectObject(dc: isize, object: isize) -> isize;
        fn BitBlt(
            dst: isize,
            x: i32,
            y: i32,
            w: i32,
            h: i32,
            src: isize,
            sx: i32,
            sy: i32,
            rop: u32,
        ) -> i32;
        fn GetDIBits(
            dc: isize,
            bitmap: isize,
            start: u32,
            lines: u32,
            bits: *mut u8,
            info: *mut BitmapInfo,
            usage: u32,
        ) -> i32;
        fn DeleteObject(object: isize) -> i32;
        fn DeleteDC(dc: isize) -> i32;
    }

    const SRCCOPY: u32 = 0x00CC_0020;
    const CAPTUREBLT: u32 = 0x4000_0000;
    const MOVE: u32 = 0x0001;
    const LEFTDOWN: u32 = 0x0002;
    const LEFTUP: u32 = 0x0004;
    const RIGHTDOWN: u32 = 0x0008;
    const RIGHTUP: u32 = 0x0010;
    const MIDDLEDOWN: u32 = 0x0020;
    const MIDDLEUP: u32 = 0x0040;
    const WHEEL: u32 = 0x0800;
    const HWHEEL: u32 = 0x1000;
    const VIRTUALDESK: u32 = 0x4000;
    const ABSOLUTE: u32 = 0x8000;
    const KEYUP: u32 = 0x0002;
    const UNICODE: u32 = 0x0004;
    const EXTENDED: u32 = 0x0001;

    pub struct Win32;
    impl Win32 {
        pub fn new() -> Self {
            Win32
        }
        fn virtual_screen() -> Rect {
            unsafe {
                Rect {
                    x: GetSystemMetrics(76) as f64,
                    y: GetSystemMetrics(77) as f64,
                    w: GetSystemMetrics(78) as f64,
                    h: GetSystemMetrics(79) as f64,
                }
            }
        }
        fn send(inputs: &[Input]) -> Result<(), String> {
            let sent = unsafe {
                SendInput(
                    inputs.len() as u32,
                    inputs.as_ptr(),
                    std::mem::size_of::<Input>() as i32,
                )
            };
            if sent as usize != inputs.len() {
                return Err("Windows не принял ввод (окно с правами администратора?)".into());
            }
            Ok(())
        }
        fn mouse(flags: u32, data: u32, dx: i32, dy: i32) -> Input {
            Input {
                kind: 0,
                u: InputUnion {
                    mi: MouseInput {
                        dx,
                        dy,
                        data,
                        flags,
                        time: 0,
                        extra: 0,
                    },
                },
            }
        }
        fn keybd(vk: u16, scan: u16, flags: u32) -> Input {
            Input {
                kind: 1,
                u: InputUnion {
                    ki: KeybdInput {
                        vk,
                        scan,
                        flags,
                        time: 0,
                        extra: 0,
                    },
                },
            }
        }
    }

    impl Backend for Win32 {
        fn capture(&mut self, window: Option<&str>) -> Result<Frame, String> {
            let screen = Self::virtual_screen();
            let mut area = screen;
            if let Some(id) = window {
                let hwnd = id.parse::<isize>().map_err(|_| "Неверное окно")?;
                let mut r = WinRect::default();
                if unsafe { IsWindow(hwnd) } == 0 || unsafe { GetWindowRect(hwnd, &mut r) } == 0 {
                    return Err("Окно не найдено".into());
                }
                let x0 = (r.left as f64).max(screen.x);
                let y0 = (r.top as f64).max(screen.y);
                let x1 = (r.right as f64).min(screen.x + screen.w);
                let y1 = (r.bottom as f64).min(screen.y + screen.h);
                if x1 <= x0 || y1 <= y0 {
                    return Err("Окно вне экрана".into());
                }
                area = Rect {
                    x: x0,
                    y: y0,
                    w: x1 - x0,
                    h: y1 - y0,
                };
            }
            let (w, h) = (area.w as i32, area.h as i32);
            let mut bgra = vec![0u8; (w * h * 4) as usize];
            unsafe {
                let screen_dc = GetDC(0);
                let mem = CreateCompatibleDC(screen_dc);
                let bitmap = CreateCompatibleBitmap(screen_dc, w, h);
                let old = SelectObject(mem, bitmap);
                let ok = BitBlt(
                    mem,
                    0,
                    0,
                    w,
                    h,
                    screen_dc,
                    area.x as i32,
                    area.y as i32,
                    SRCCOPY | CAPTUREBLT,
                );
                let mut info = BitmapInfo {
                    header: BitmapInfoHeader {
                        size: std::mem::size_of::<BitmapInfoHeader>() as u32,
                        width: w,
                        height: -h,
                        planes: 1,
                        bit_count: 32,
                        compression: 0,
                        size_image: 0,
                        x_ppm: 0,
                        y_ppm: 0,
                        clr_used: 0,
                        clr_important: 0,
                    },
                    colors: [0; 3],
                };
                let lines = GetDIBits(mem, bitmap, 0, h as u32, bgra.as_mut_ptr(), &mut info, 0);
                SelectObject(mem, old);
                DeleteObject(bitmap);
                DeleteDC(mem);
                ReleaseDC(0, screen_dc);
                if ok == 0 || lines != h {
                    return Err("Не удалось сделать снимок".into());
                }
            }
            let rgb = bgra
                .chunks_exact(4)
                .flat_map(|p| [p[2], p[1], p[0]])
                .collect();
            Ok(Frame {
                width: w as u32,
                height: h as u32,
                rgb,
                area,
            })
        }
        fn move_to(&mut self, x: f64, y: f64) -> Result<(), String> {
            let s = Self::virtual_screen();
            let nx = ((x - s.x) * 65535.0 / (s.w - 1.0).max(1.0)).round() as i32;
            let ny = ((y - s.y) * 65535.0 / (s.h - 1.0).max(1.0)).round() as i32;
            Self::send(&[Self::mouse(MOVE | ABSOLUTE | VIRTUALDESK, 0, nx, ny)])
        }
        fn button(&mut self, button: Button, down: bool) -> Result<(), String> {
            let flag = match (button, down) {
                (Button::Left, true) => LEFTDOWN,
                (Button::Left, false) => LEFTUP,
                (Button::Right, true) => RIGHTDOWN,
                (Button::Right, false) => RIGHTUP,
                (Button::Middle, true) => MIDDLEDOWN,
                (Button::Middle, false) => MIDDLEUP,
            };
            Self::send(&[Self::mouse(flag, 0, 0, 0)])
        }
        fn scroll(&mut self, dx: i32, dy: i32) -> Result<(), String> {
            if dy != 0 {
                Self::send(&[Self::mouse(WHEEL, (-dy * 120) as u32, 0, 0)])?;
            }
            if dx != 0 {
                Self::send(&[Self::mouse(HWHEEL, (dx * 120) as u32, 0, 0)])?;
            }
            Ok(())
        }
        fn key(&mut self, key: Key, down: bool) -> Result<(), String> {
            let mut flags = if down { 0 } else { KEYUP };
            if key.extended {
                flags |= EXTENDED;
            }
            Self::send(&[Self::keybd(key.vk, 0, flags)])
        }
        fn text(&mut self, text: &str) -> Result<(), String> {
            let mut inputs = Vec::new();
            for unit in text.replace('\n', "\r").encode_utf16() {
                inputs.push(Self::keybd(0, unit, UNICODE));
                inputs.push(Self::keybd(0, unit, UNICODE | KEYUP));
            }
            Self::send(&inputs)
        }
    }
}

// ---------- Linux X11: GetImage + XTest ----------

#[cfg(target_os = "linux")]
mod x11 {
    use super::*;
    use std::sync::OnceLock;
    use x11rb::{
        connection::{Connection, RequestConnection},
        protocol::{
            xproto::{self, ConnectionExt as _, ImageFormat},
            xtest::ConnectionExt as _,
        },
        rust_connection::RustConnection,
        wrapper::ConnectionExt as _,
        CURRENT_TIME,
    };

    pub fn probe() -> (bool, bool) {
        static PROBE: OnceLock<(bool, bool)> = OnceLock::new();
        *PROBE.get_or_init(|| match x11rb::connect(None) {
            Ok((conn, _)) => {
                let xtest = conn
                    .extension_information(x11rb::protocol::xtest::X11_EXTENSION_NAME)
                    .ok()
                    .flatten()
                    .is_some();
                (true, xtest)
            }
            Err(_) => (false, false),
        })
    }

    pub struct X11 {
        conn: RustConnection,
        root: xproto::Window,
        min_keycode: u8,
        per: u8,
        syms: Vec<u32>,
    }

    impl X11 {
        pub fn connect() -> Result<Self, String> {
            let (conn, screen) = x11rb::connect(None).map_err(|_| "Нет подключения к X11")?;
            let setup = conn.setup();
            let root = setup.roots[screen].root;
            let (min_keycode, max_keycode) = (setup.min_keycode, setup.max_keycode);
            let mapping = conn
                .get_keyboard_mapping(min_keycode, max_keycode - min_keycode + 1)
                .map_err(|_| "X11: раскладка недоступна")?
                .reply()
                .map_err(|_| "X11: раскладка недоступна")?;
            Ok(Self {
                conn,
                root,
                min_keycode,
                per: mapping.keysyms_per_keycode,
                syms: mapping.keysyms,
            })
        }
        fn fake(&self, kind: u8, detail: u8, x: i16, y: i16) -> Result<(), String> {
            self.conn
                .xtest_fake_input(kind, detail, CURRENT_TIME, self.root, x, y, 0)
                .map_err(|_| "X11 не принял ввод")?;
            self.conn
                .flush()
                .map_err(|_| "X11 не принял ввод".to_string())
        }
        /// (keycode, needs_shift) for a keysym in the current layout.
        fn keycode(&self, keysym: u32) -> Option<(u8, bool)> {
            let per = self.per as usize;
            self.syms.chunks(per).enumerate().find_map(|(i, row)| {
                let code = self.min_keycode as usize + i;
                if row.first() == Some(&keysym) {
                    Some((code as u8, false))
                } else if row.get(1) == Some(&keysym) {
                    Some((code as u8, true))
                } else {
                    None
                }
            })
        }
        fn spare_keycode(&self) -> Option<u8> {
            let per = self.per as usize;
            self.syms
                .chunks(per)
                .enumerate()
                .rev()
                .find(|(_, row)| row.iter().all(|s| *s == 0))
                .map(|(i, _)| (self.min_keycode as usize + i) as u8)
        }
        fn tap(&self, code: u8, shift: bool) -> Result<(), String> {
            let shift_code = self.keycode(0xffe1).map(|k| k.0);
            if shift {
                if let Some(s) = shift_code {
                    self.fake(xproto::KEY_PRESS_EVENT, s, 0, 0)?;
                }
            }
            self.fake(xproto::KEY_PRESS_EVENT, code, 0, 0)?;
            self.fake(xproto::KEY_RELEASE_EVENT, code, 0, 0)?;
            if shift {
                if let Some(s) = shift_code {
                    self.fake(xproto::KEY_RELEASE_EVENT, s, 0, 0)?;
                }
            }
            Ok(())
        }
        fn type_keysym(&mut self, keysym: u32) -> Result<(), String> {
            if let Some((code, shift)) = self.keycode(keysym) {
                return self.tap(code, shift);
            }
            // Characters missing from the layout: borrow an unused keycode, then restore it.
            let code = self
                .spare_keycode()
                .ok_or("X11: нет свободной клавиши для символа")?;
            let per = self.per as usize;
            let mut row = vec![0u32; per];
            row[0] = keysym;
            if per > 1 {
                row[1] = keysym;
            }
            self.conn
                .change_keyboard_mapping(1, code, self.per, &row)
                .map_err(|_| "X11 не принял ввод")?;
            self.conn.sync().map_err(|_| "X11 не принял ввод")?;
            std::thread::sleep(Duration::from_millis(15));
            let result = self.tap(code, false);
            std::thread::sleep(Duration::from_millis(15));
            let _ = self
                .conn
                .change_keyboard_mapping(1, code, self.per, &vec![0u32; per]);
            let _ = self.conn.sync();
            result
        }
    }

    impl Backend for X11 {
        fn capture(&mut self, window: Option<&str>) -> Result<Frame, String> {
            let geometry = self
                .conn
                .get_geometry(self.root)
                .map_err(|_| "X11: экран недоступен")?
                .reply()
                .map_err(|_| "X11: экран недоступен")?;
            let mut area = Rect {
                x: 0.0,
                y: 0.0,
                w: geometry.width as f64,
                h: geometry.height as f64,
            };
            if let Some(id) = window {
                let hex = id.strip_prefix("0x").ok_or("Неверное окно")?;
                let win = u32::from_str_radix(hex, 16).map_err(|_| "Неверное окно")?;
                let g = self
                    .conn
                    .get_geometry(win)
                    .map_err(|_| "Окно не найдено")?
                    .reply()
                    .map_err(|_| "Окно не найдено")?;
                let t = self
                    .conn
                    .translate_coordinates(win, self.root, 0, 0)
                    .map_err(|_| "Окно не найдено")?
                    .reply()
                    .map_err(|_| "Окно не найдено")?;
                let x0 = (t.dst_x as f64).max(0.0);
                let y0 = (t.dst_y as f64).max(0.0);
                let x1 = (t.dst_x as f64 + g.width as f64).min(area.w);
                let y1 = (t.dst_y as f64 + g.height as f64).min(area.h);
                if x1 <= x0 || y1 <= y0 {
                    return Err("Окно вне экрана".into());
                }
                area = Rect {
                    x: x0,
                    y: y0,
                    w: x1 - x0,
                    h: y1 - y0,
                };
            }
            let image = self
                .conn
                .get_image(
                    ImageFormat::Z_PIXMAP,
                    self.root,
                    area.x as i16,
                    area.y as i16,
                    area.w as u16,
                    area.h as u16,
                    !0,
                )
                .map_err(|_| "X11: снимок недоступен")?
                .reply()
                .map_err(|_| "X11: снимок недоступен")?;
            let (w, h) = (area.w as usize, area.h as usize);
            if image.depth < 24 || image.data.len() < w * h * 4 {
                return Err("X11: неподдерживаемый формат экрана".into());
            }
            let rgb = image.data[..w * h * 4]
                .chunks_exact(4)
                .flat_map(|p| [p[2], p[1], p[0]])
                .collect();
            Ok(Frame {
                width: w as u32,
                height: h as u32,
                rgb,
                area,
            })
        }
        fn move_to(&mut self, x: f64, y: f64) -> Result<(), String> {
            self.fake(
                xproto::MOTION_NOTIFY_EVENT,
                0,
                x.round() as i16,
                y.round() as i16,
            )
        }
        fn button(&mut self, button: Button, down: bool) -> Result<(), String> {
            let detail = match button {
                Button::Left => 1,
                Button::Middle => 2,
                Button::Right => 3,
            };
            let kind = if down {
                xproto::BUTTON_PRESS_EVENT
            } else {
                xproto::BUTTON_RELEASE_EVENT
            };
            self.fake(kind, detail, 0, 0)
        }
        fn scroll(&mut self, dx: i32, dy: i32) -> Result<(), String> {
            for (amount, neg, pos) in [(dy, 4u8, 5u8), (dx, 6u8, 7u8)] {
                let b = if amount < 0 { neg } else { pos };
                for _ in 0..amount.unsigned_abs() {
                    self.fake(xproto::BUTTON_PRESS_EVENT, b, 0, 0)?;
                    self.fake(xproto::BUTTON_RELEASE_EVENT, b, 0, 0)?;
                }
            }
            Ok(())
        }
        fn key(&mut self, key: Key, down: bool) -> Result<(), String> {
            let (code, _) = self
                .keycode(key.keysym)
                .ok_or("X11: клавиша отсутствует в раскладке")?;
            let kind = if down {
                xproto::KEY_PRESS_EVENT
            } else {
                xproto::KEY_RELEASE_EVENT
            };
            self.fake(kind, code, 0, 0)
        }
        fn text(&mut self, text: &str) -> Result<(), String> {
            for c in text.chars() {
                let keysym = match c {
                    '\n' => 0xff0d,
                    '\t' => 0xff09,
                    c if (c as u32) < 0x100 => c as u32,
                    c => 0x0100_0000 | c as u32,
                };
                self.type_keysym(keysym)?;
            }
            Ok(())
        }
    }
}

// ---------- Linux Wayland: xdg-desktop-portal Screenshot + RemoteDesktop/ScreenCast ----------

#[cfg(target_os = "linux")]
mod wayland {
    use super::*;
    use ashpd::desktop::{
        remote_desktop::{Axis, DeviceType, KeyState, RemoteDesktop},
        screencast::{CursorMode, Screencast, SourceType},
        PersistMode,
    };
    use std::sync::{
        atomic::AtomicU8,
        mpsc::{self, Sender},
    };

    // 0 = unknown, 1 = no, 2 = yes. Probed once in the background at startup.
    static SCREENSHOT: AtomicU8 = AtomicU8::new(0);
    static REMOTE: AtomicU8 = AtomicU8::new(0);

    pub fn start_probe() {
        std::thread::spawn(|| {
            let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            else {
                SCREENSHOT.store(1, Ordering::SeqCst);
                REMOTE.store(1, Ordering::SeqCst);
                return;
            };
            rt.block_on(async {
                let shot = async {
                    let conn = ashpd::zbus::Connection::session().await.ok()?;
                    let proxy = ashpd::zbus::Proxy::new(
                        &conn,
                        "org.freedesktop.portal.Desktop",
                        "/org/freedesktop/portal/desktop",
                        "org.freedesktop.portal.Screenshot",
                    )
                    .await
                    .ok()?;
                    proxy.get_property::<u32>("version").await.ok()
                }
                .await
                .is_some();
                SCREENSHOT.store(if shot { 2 } else { 1 }, Ordering::SeqCst);
                let remote = match RemoteDesktop::new().await {
                    Ok(p) => p.available_device_types().await.is_ok_and(|t| {
                        t.contains(DeviceType::Keyboard) && t.contains(DeviceType::Pointer)
                    }),
                    Err(_) => false,
                };
                let cast = Screencast::new().await.is_ok();
                REMOTE.store(if remote && cast { 2 } else { 1 }, Ordering::SeqCst);
            });
        });
    }

    pub fn probe() -> (bool, bool) {
        (
            SCREENSHOT.load(Ordering::SeqCst) == 2,
            REMOTE.load(Ordering::SeqCst) == 2,
        )
    }

    enum Request {
        Capture,
        Move(f64, f64),
        Button(i32, bool),
        Scroll(i32, i32),
        Keysym(i32, bool),
    }
    type Reply = Result<Option<Frame>, String>;

    /// Portal calls run on one dedicated thread with its own runtime; the RemoteDesktop
    /// session (one user consent dialog) lives there until the backend is reset.
    pub struct Portal {
        tx: Sender<(Request, Sender<Reply>)>,
        full: (f64, f64),
    }

    #[derive(Clone, Copy)]
    struct StreamArea {
        node: u32,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    }

    impl Portal {
        pub fn start() -> Result<Self, String> {
            let (tx, rx) = mpsc::channel::<(Request, Sender<Reply>)>();
            std::thread::spawn(move || {
                let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                else {
                    return;
                };
                rt.block_on(async move {
                    let mut remote: Option<(
                        RemoteDesktop<'static>,
                        ashpd::desktop::Session<'static, RemoteDesktop<'static>>,
                        Vec<StreamArea>,
                    )> = None;
                    while let Ok((request, reply)) = rx.recv() {
                        let result: Reply = async {
                            if matches!(request, Request::Capture) {
                                return capture().await.map(Some);
                            }
                            if remote.is_none() {
                                remote = Some(open_remote().await?);
                            }
                            let (proxy, session, streams) =
                                remote.as_ref().ok_or("Портал недоступен")?;
                            match request {
                                Request::Capture => unreachable!(),
                                Request::Move(fx, fy) => {
                                    // Fractions of the full screenshot → the streams' logical union.
                                    let ux =
                                        streams.iter().map(|s| s.x).fold(f64::INFINITY, f64::min);
                                    let uy =
                                        streams.iter().map(|s| s.y).fold(f64::INFINITY, f64::min);
                                    let ur = streams
                                        .iter()
                                        .map(|s| s.x + s.w)
                                        .fold(f64::NEG_INFINITY, f64::max);
                                    let ub = streams
                                        .iter()
                                        .map(|s| s.y + s.h)
                                        .fold(f64::NEG_INFINITY, f64::max);
                                    let (x, y) = (ux + fx * (ur - ux), uy + fy * (ub - uy));
                                    let s = streams
                                        .iter()
                                        .find(|s| {
                                            x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h
                                        })
                                        .or(streams.first())
                                        .ok_or("Портал не дал экран для ввода")?;
                                    proxy
                                        .notify_pointer_motion_absolute(
                                            session,
                                            s.node,
                                            (x - s.x).clamp(0.0, s.w - 1.0),
                                            (y - s.y).clamp(0.0, s.h - 1.0),
                                        )
                                        .await
                                        .map_err(|_| "Портал отклонил ввод".to_string())?;
                                }
                                Request::Button(code, down) => proxy
                                    .notify_pointer_button(
                                        session,
                                        code,
                                        if down {
                                            KeyState::Pressed
                                        } else {
                                            KeyState::Released
                                        },
                                    )
                                    .await
                                    .map_err(|_| "Портал отклонил ввод".to_string())?,
                                Request::Scroll(dx, dy) => {
                                    if dy != 0 {
                                        proxy
                                            .notify_pointer_axis_discrete(
                                                session,
                                                Axis::Vertical,
                                                dy,
                                            )
                                            .await
                                            .map_err(|_| "Портал отклонил ввод".to_string())?;
                                    }
                                    if dx != 0 {
                                        proxy
                                            .notify_pointer_axis_discrete(
                                                session,
                                                Axis::Horizontal,
                                                dx,
                                            )
                                            .await
                                            .map_err(|_| "Портал отклонил ввод".to_string())?;
                                    }
                                }
                                Request::Keysym(sym, down) => proxy
                                    .notify_keyboard_keysym(
                                        session,
                                        sym,
                                        if down {
                                            KeyState::Pressed
                                        } else {
                                            KeyState::Released
                                        },
                                    )
                                    .await
                                    .map_err(|_| "Портал отклонил ввод".to_string())?,
                            }
                            Ok(None)
                        }
                        .await;
                        if result.is_err() {
                            remote = None;
                        }
                        let _ = reply.send(result);
                    }
                    if let Some((_, session, _)) = remote {
                        let _ = session.close().await;
                    }
                });
            });
            Ok(Self {
                tx,
                full: (0.0, 0.0),
            })
        }

        fn ask(&self, request: Request, timeout: Duration) -> Reply {
            let (tx, rx) = mpsc::channel();
            self.tx
                .send((request, tx))
                .map_err(|_| "Портал недоступен")?;
            rx.recv_timeout(timeout)
                .map_err(|_| "Портал не ответил (диалог разрешения закрыт?)".to_string())?
        }
    }

    async fn capture() -> Result<Frame, String> {
        let response = ashpd::desktop::screenshot::Screenshot::request()
            .interactive(false)
            .modal(false)
            .send()
            .await
            .and_then(|r| r.response())
            .map_err(|_| "Портал снимка отказал")?;
        let path = response
            .uri()
            .to_file_path()
            .map_err(|_| "Портал вернул не файл")?;
        let bytes = std::fs::read(&path).map_err(|_| "Снимок недоступен");
        // The portal saves into the user's Pictures folder; the agent leaves no copies behind.
        let _ = std::fs::remove_file(&path);
        let bytes = bytes?;
        let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
        let mut reader = decoder.read_info().map_err(|_| "Неверный PNG")?;
        let mut buffer = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buffer).map_err(|_| "Неверный PNG")?;
        if info.bit_depth != png::BitDepth::Eight {
            return Err("Неподдерживаемый формат снимка".into());
        }
        let channels = match info.color_type {
            png::ColorType::Rgb => 3,
            png::ColorType::Rgba => 4,
            _ => return Err("Неподдерживаемый формат снимка".into()),
        };
        let rgb = buffer[..info.buffer_size()]
            .chunks_exact(channels)
            .flat_map(|p| [p[0], p[1], p[2]])
            .collect();
        Ok(Frame {
            width: info.width,
            height: info.height,
            rgb,
            area: Rect {
                x: 0.0,
                y: 0.0,
                w: info.width as f64,
                h: info.height as f64,
            },
        })
    }

    async fn open_remote() -> Result<
        (
            RemoteDesktop<'static>,
            ashpd::desktop::Session<'static, RemoteDesktop<'static>>,
            Vec<StreamArea>,
        ),
        String,
    > {
        let fail = |_| "Портал удалённого управления недоступен".to_string();
        let proxy = RemoteDesktop::new().await.map_err(fail)?;
        let cast = Screencast::new().await.map_err(fail)?;
        let session = proxy.create_session().await.map_err(fail)?;
        proxy
            .select_devices(
                &session,
                DeviceType::Keyboard | DeviceType::Pointer,
                None,
                PersistMode::DoNot,
            )
            .await
            .map_err(fail)?;
        cast.select_sources(
            &session,
            CursorMode::Hidden,
            SourceType::Monitor.into(),
            true,
            None,
            PersistMode::DoNot,
        )
        .await
        .map_err(fail)?;
        let started = proxy
            .start(&session, None)
            .await
            .and_then(|r| r.response())
            .map_err(|_| "Пользователь не разрешил управление в диалоге системы".to_string())?;
        let streams: Vec<StreamArea> = started
            .streams()
            .unwrap_or_default()
            .iter()
            .filter_map(|s| {
                let (x, y) = s.position().unwrap_or((0, 0));
                let (w, h) = s.size()?;
                Some(StreamArea {
                    node: s.pipe_wire_node_id(),
                    x: x as f64,
                    y: y as f64,
                    w: w as f64,
                    h: h as f64,
                })
            })
            .collect();
        if streams.is_empty() {
            return Err("Портал не дал экран для ввода".into());
        }
        Ok((proxy, session, streams))
    }

    impl Backend for Portal {
        fn capture(&mut self, window: Option<&str>) -> Result<Frame, String> {
            if window.is_some() {
                return Err("На Wayland доступен только снимок всего экрана".into());
            }
            let frame = self
                .ask(Request::Capture, Duration::from_secs(20))?
                .ok_or("Нет снимка")?;
            self.full = (frame.width as f64, frame.height as f64);
            Ok(frame)
        }
        fn move_to(&mut self, x: f64, y: f64) -> Result<(), String> {
            // Screenshot pixels are mapped to the streams' logical layout on the portal thread.
            let (fw, fh) = self.full;
            if fw <= 0.0 || fh <= 0.0 {
                return Err("Сначала сделайте снимок".into());
            }
            self.ask(Request::Move(x / fw, y / fh), Duration::from_secs(60))
                .map(|_| ())
        }
        fn button(&mut self, button: Button, down: bool) -> Result<(), String> {
            let code = match button {
                Button::Left => 0x110,
                Button::Right => 0x111,
                Button::Middle => 0x112,
            };
            self.ask(Request::Button(code, down), Duration::from_secs(5))
                .map(|_| ())
        }
        fn scroll(&mut self, dx: i32, dy: i32) -> Result<(), String> {
            self.ask(Request::Scroll(dx, dy), Duration::from_secs(5))
                .map(|_| ())
        }
        fn key(&mut self, key: Key, down: bool) -> Result<(), String> {
            self.ask(
                Request::Keysym(key.keysym as i32, down),
                Duration::from_secs(60),
            )
            .map(|_| ())
        }
        fn text(&mut self, text: &str) -> Result<(), String> {
            for c in text.chars() {
                let sym = match c {
                    '\n' => 0xff0d,
                    '\t' => 0xff09,
                    c if (c as u32) < 0x100 => c as u32,
                    c => 0x0100_0000 | c as u32,
                } as i32;
                self.ask(Request::Keysym(sym, true), Duration::from_secs(60))?;
                self.ask(Request::Keysym(sym, false), Duration::from_secs(5))?;
            }
            Ok(())
        }
    }
}

#[cfg(target_os = "linux")]
pub fn start_probe() {
    if session_kind() == "wayland" {
        wayland::start_probe();
    }
}
#[cfg(not(target_os = "linux"))]
pub fn start_probe() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Mock {
        log: Vec<String>,
        held_keys: Vec<&'static str>,
        cancel_after: Option<(usize, std::sync::Arc<AtomicBool>)>,
    }
    impl Mock {
        fn note(&mut self, s: String) {
            self.log.push(s);
            if let Some((n, flag)) = &self.cancel_after {
                if self.log.len() >= *n {
                    flag.store(true, Ordering::SeqCst);
                }
            }
        }
    }
    impl Backend for Mock {
        fn capture(&mut self, _: Option<&str>) -> Result<Frame, String> {
            // 2560x1440 physical desktop starting at x=-1920 (second monitor on the left).
            Ok(Frame {
                width: 2560,
                height: 1440,
                rgb: vec![128; 2560 * 1440 * 3],
                area: Rect {
                    x: -1920.0,
                    y: 0.0,
                    w: 2560.0,
                    h: 1440.0,
                },
            })
        }
        fn move_to(&mut self, x: f64, y: f64) -> Result<(), String> {
            self.note(format!("move {x:.0} {y:.0}"));
            Ok(())
        }
        fn button(&mut self, b: Button, down: bool) -> Result<(), String> {
            self.note(format!("button {b:?} {down}"));
            Ok(())
        }
        fn scroll(&mut self, dx: i32, dy: i32) -> Result<(), String> {
            self.note(format!("scroll {dx} {dy}"));
            Ok(())
        }
        fn key(&mut self, k: Key, down: bool) -> Result<(), String> {
            if down {
                self.held_keys.push(k.name);
            } else {
                self.held_keys.retain(|n| *n != k.name);
            }
            self.note(format!("key {} {down}", k.name));
            Ok(())
        }
        fn text(&mut self, t: &str) -> Result<(), String> {
            self.note(format!("text {t}"));
            Ok(())
        }
    }
    fn args(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn screenshot_is_downscaled_and_coordinates_map_back_with_offsets() {
        let mut m = Mock::default();
        let shot = capture(&mut m, None, "s").unwrap();
        assert_eq!(shot["width"], 1366);
        assert_eq!(shot["height"], 768);
        let id = shot["screenshot_id"].as_str().unwrap();
        let s = find_shot(id, "s").unwrap();
        let (x, y) = map_point(&s, 683.0, 384.0).unwrap();
        // Centre of the image → centre of the physical virtual desktop.
        assert!((x - (-1920.0 + 1280.0)).abs() < 2.0, "{x}");
        assert!((y - 720.0).abs() < 2.0, "{y}");
        assert!(map_point(&s, 1366.0, 10.0).is_err());
        assert!(find_shot(id, "other-session").is_err());
    }

    #[test]
    fn sequences_are_validated_before_anything_is_sent() {
        for bad in [
            json!({"steps":[]}),
            json!({"steps":[{"op":"click","x":1,"y":1}]}),
            json!({"steps":[{"op":"key","keys":"ctrl+alt+delete"}]}),
            json!({"steps":[{"op":"key","keys":"ctrl+printscreen"}]}),
            json!({"steps":[{"op":"key","keys":"a+b"}]}),
            json!({"steps":[{"op":"type","text":"x".repeat(501)}]}),
            json!({"steps":[{"op":"type","text":"a\u{7}b"}]}),
            json!({"steps":[{"op":"wait","ms":10_000}]}),
            json!({"steps":[{"op":"scroll","x":1,"y":1,"dy":50}], "screenshot_id": uuid::Uuid::new_v4().to_string()}),
            json!({"steps":[{"op":"shell","cmd":"x"}]}),
            json!({"steps":[{"op":"key","keys":"enter","extra":1}]}),
            json!({"steps": vec![json!({"op":"key","keys":"a"}); MAX_STEPS + 1]}),
        ] {
            assert!(parse(&args(bad.clone())).is_err(), "{bad}");
        }
        // An out-of-image point anywhere aborts the whole sequence before the first step.
        let mut m = Mock::default();
        let id = capture(&mut m, None, "s").unwrap()["screenshot_id"]
            .as_str()
            .unwrap()
            .to_string();
        let mut m = Mock::default();
        let out = run(
            &mut m,
            &args(
                json!({"screenshot_id":id,"steps":[{"op":"key","keys":"enter"},{"op":"click","x":5000,"y":1}]}),
            ),
            "s",
            &AtomicBool::new(false),
        );
        assert!(out.is_err());
        assert!(m.log.is_empty());
    }

    #[test]
    fn stop_midway_releases_held_keys_and_halts() {
        let mut m = Mock::default();
        let id = capture(&mut m, None, "s").unwrap()["screenshot_id"]
            .as_str()
            .unwrap()
            .to_string();
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let mut m = Mock {
            cancel_after: Some((2, cancel.clone())),
            ..Default::default()
        };
        let out = run(
            &mut m,
            &args(json!({"screenshot_id":id,"steps":[
                {"op":"key","keys":"ctrl+shift+s"},
                {"op":"click","x":10,"y":10},
                {"op":"type","text":"never"}
            ]})),
            "s",
            &cancel,
        )
        .unwrap();
        assert_eq!(out["status"], "cancelled");
        assert!(m.held_keys.is_empty(), "keys left down: {:?}", m.held_keys);
        assert!(!m.log.iter().any(|l| l.contains("never")));
        assert!(!m.log.iter().any(|l| l.starts_with("button")));
    }

    #[test]
    fn full_sequence_runs_in_order() {
        let mut m = Mock::default();
        let id = capture(&mut m, None, "s").unwrap()["screenshot_id"]
            .as_str()
            .unwrap()
            .to_string();
        let mut m = Mock::default();
        let out = run(
            &mut m,
            &args(json!({"screenshot_id":id,"steps":[
                {"op":"click","x":0,"y":0,"count":2},
                {"op":"type","text":"hi"},
                {"op":"key","keys":"ctrl+s"},
                {"op":"scroll","x":1,"y":1,"dy":-3}
            ]})),
            "s",
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(out["completed_steps"], 4);
        assert_eq!(
            m.log
                .iter()
                .filter(|l| l.starts_with("button Left true"))
                .count(),
            2
        );
        assert!(m.log.contains(&"text hi".to_string()));
        assert!(m.log.contains(&"scroll 0 -3".to_string()));
    }

    #[test]
    fn preview_lists_every_step() {
        let (_, steps) = parse(&args(
            json!({"steps":[{"op":"type","text":"привет"},{"op":"key","keys":"ctrl+enter"}]}),
        ))
        .unwrap();
        let text = preview(&steps);
        assert!(text.contains("«привет»"));
        assert!(text.contains("ctrl+enter"));
    }

    /// Real X server round trip; runs only when DISPLAY points at Xvfb or a desktop.
    #[cfg(target_os = "linux")]
    #[test]
    fn x11_backend_captures_and_moves_pointer() {
        if session_kind() != "x11" || !x11::probe().1 {
            return;
        }
        let mut backend = x11::X11::connect().unwrap();
        let shot = capture(&mut backend, None, "x").unwrap();
        assert!(shot["width"].as_u64().unwrap() > 0);
        let id = shot["screenshot_id"].as_str().unwrap().to_string();
        let out = run(
            &mut backend,
            &args(json!({"screenshot_id":id,"steps":[{"op":"move","x":10,"y":20}]})),
            "x",
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(out["status"], "ok");
        use x11rb::protocol::xproto::ConnectionExt;
        let (conn, screen) = x11rb::connect(None).unwrap();
        let root = x11rb::connection::Connection::setup(&conn).roots[screen].root;
        let pointer = conn.query_pointer(root).unwrap().reply().unwrap();
        let s = find_shot(&id, "x").unwrap();
        let (ex, ey) = map_point(&s, 10.0, 20.0).unwrap();
        assert!(
            (pointer.root_x as f64 - ex).abs() <= 1.0,
            "{} vs {ex}",
            pointer.root_x
        );
        assert!(
            (pointer.root_y as f64 - ey).abs() <= 1.0,
            "{} vs {ey}",
            pointer.root_y
        );
    }
}
