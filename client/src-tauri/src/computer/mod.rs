// Accessibility/ref design adapted from agent-desktop (Apache-2.0); see NOTICE.
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

use crate::policy::ToolCall;
#[cfg(any(target_os = "windows", target_os = "macos", test))]
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{atomic::AtomicBool, Arc};
#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Mutex,
    },
    time::{Duration, Instant},
};

#[cfg(any(target_os = "windows", target_os = "macos", test))]
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Node {
    #[serde(rename = "ref")]
    pub reference: String,
    pub role: String,
    pub name: String,
    pub enabled: bool,
    pub children: Vec<Node>,
}

#[cfg(any(target_os = "windows", target_os = "macos", test))]
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Snapshot {
    pub snapshot_id: String,
    pub tree: Node,
    pub truncated: bool,
}

#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    StaleRef,
    NotFound,
    PermissionDenied,
    UnsupportedPlatform,
    Timeout,
    Cancelled,
    InvalidArguments,
    ActionFailed,
    ActionFailedNotDelivered,
}

impl Error {
    pub fn from_policy(code: &str) -> Self {
        match code {
            "unsupported_platform" => Self::UnsupportedPlatform,
            "invalid_arguments" => Self::InvalidArguments,
            "timeout" => Self::Timeout,
            "cancelled" => Self::Cancelled,
            _ => Self::PermissionDenied,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Self::StaleRef => "stale_ref",
            Self::NotFound => "not_found",
            Self::PermissionDenied => "permission_denied",
            Self::UnsupportedPlatform => "unsupported_platform",
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
            Self::InvalidArguments => "invalid_arguments",
            Self::ActionFailed | Self::ActionFailedNotDelivered => "action_failed",
        }
    }

    // Numeric mappings are shared with Linux tests; never forward OS descriptions or arguments.
    #[cfg(any(target_os = "windows", test))]
    pub(super) fn from_windows_hresult(code: i32) -> Self {
        match code as u32 {
            0x8007_0005 => Self::PermissionDenied,
            0x8004_0201 | 0x8001_0108 | 0x8007_06ba => Self::StaleRef,
            0x8013_1505 | 0x8007_05b4 => Self::Timeout,
            0x8007_0057 => Self::InvalidArguments,
            0x8007_0490 => Self::NotFound,
            _ => Self::ActionFailed,
        }
    }

    #[cfg(any(target_os = "macos", test))]
    pub(super) fn from_ax_error(code: i32) -> Self {
        match code {
            -25202 => Self::StaleRef,
            -25204 => Self::Timeout,
            -25211 => Self::PermissionDenied,
            -25212 => Self::NotFound,
            -25201 => Self::InvalidArguments,
            _ => Self::ActionFailed,
        }
    }

    pub fn response(self, mutating: bool) -> Value {
        let unknown =
            mutating && matches!(self, Self::Timeout | Self::Cancelled | Self::ActionFailed);
        json!({"status":"error", "code":self.code(), "retry":false,
            "delivery":if unknown { "unknown" } else { "not_delivered" }})
    }
}

pub fn is_tool(tool: &str) -> bool {
    matches!(
        tool,
        "client.computer_snapshot"
            | "client.computer_click"
            | "client.computer_type"
            | "client.computer_press"
    )
}

pub const fn supported() -> bool {
    cfg!(any(target_os = "windows", target_os = "macos"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Key {
    Ctrl,
    Alt,
    Shift,
    Meta,
    Enter,
    Tab,
    Escape,
    Backspace,
    Delete,
    Space,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    Letter(u8),
    Digit(u8),
    Function(u8),
}

impl Key {
    fn parse(value: &str) -> Result<Self, Error> {
        let lower = value.to_ascii_lowercase();
        Ok(match lower.as_str() {
            "ctrl" | "control" => Self::Ctrl,
            "alt" | "option" => Self::Alt,
            "shift" => Self::Shift,
            "meta" | "cmd" | "command" | "win" => Self::Meta,
            "enter" | "return" => Self::Enter,
            "tab" => Self::Tab,
            "escape" | "esc" => Self::Escape,
            "backspace" => Self::Backspace,
            "delete" => Self::Delete,
            "space" => Self::Space,
            "up" => Self::Up,
            "down" => Self::Down,
            "left" => Self::Left,
            "right" => Self::Right,
            "home" => Self::Home,
            "end" => Self::End,
            "pageup" => Self::PageUp,
            "pagedown" => Self::PageDown,
            _ if lower.len() == 1 && lower.as_bytes()[0].is_ascii_lowercase() => {
                Self::Letter(lower.as_bytes()[0])
            }
            _ if lower.len() == 1 && lower.as_bytes()[0].is_ascii_digit() => {
                Self::Digit(lower.as_bytes()[0])
            }
            _ => {
                let number = lower
                    .strip_prefix('f')
                    .and_then(|s| s.parse::<u8>().ok())
                    .filter(|n| (1..=12).contains(n))
                    .ok_or(Error::InvalidArguments)?;
                Self::Function(number)
            }
        })
    }

    fn modifier(self) -> bool {
        matches!(self, Self::Ctrl | Self::Alt | Self::Shift | Self::Meta)
    }
}

#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
enum Operation {
    Snapshot,
    Click(String),
    Type(String, String),
    Press(Vec<Key>),
}

impl Operation {
    fn parse(tool: &str, args: &Value) -> Result<Self, Error> {
        let args = args.as_object().ok_or(Error::InvalidArguments)?;
        let keys: &[&str] = match tool {
            "client.computer_snapshot" => &[],
            "client.computer_click" => &["ref"],
            "client.computer_type" => &["ref", "text"],
            "client.computer_press" => &["keys"],
            _ => return Err(Error::InvalidArguments),
        };
        if args.len() != keys.len() || args.keys().any(|key| !keys.contains(&key.as_str())) {
            return Err(Error::InvalidArguments);
        }
        let reference = || {
            let value = args
                .get("ref")
                .and_then(Value::as_str)
                .ok_or(Error::InvalidArguments)?;
            let (snapshot, index) = value.split_once(':').ok_or(Error::InvalidArguments)?;
            if snapshot.len() != 36
                || uuid::Uuid::parse_str(snapshot).is_err()
                || index.is_empty()
                || index.len() > 4
                || !index.bytes().all(|b| b.is_ascii_digit())
            {
                return Err(Error::InvalidArguments);
            }
            Ok(value.to_owned())
        };
        Ok(match tool {
            "client.computer_snapshot" => Self::Snapshot,
            "client.computer_click" => Self::Click(reference()?),
            "client.computer_type" => {
                let text = args
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or(Error::InvalidArguments)?;
                if text.len() > 4096
                    || text
                        .chars()
                        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
                {
                    return Err(Error::InvalidArguments);
                }
                Self::Type(reference()?, text.to_owned())
            }
            "client.computer_press" => {
                let values = args
                    .get("keys")
                    .and_then(Value::as_array)
                    .ok_or(Error::InvalidArguments)?;
                if values.is_empty() || values.len() > 5 {
                    return Err(Error::InvalidArguments);
                }
                let mut keys = Vec::new();
                for (i, value) in values.iter().enumerate() {
                    let key = Key::parse(value.as_str().ok_or(Error::InvalidArguments)?)?;
                    if keys.contains(&key) || key.modifier() == (i == values.len() - 1) {
                        return Err(Error::InvalidArguments);
                    }
                    keys.push(key);
                }
                Self::Press(keys)
            }
            _ => return Err(Error::InvalidArguments),
        })
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    fn mutating(&self) -> bool {
        !matches!(self, Self::Snapshot)
    }
}

pub fn validate_arguments(tool: &str, args: &Value) -> Result<(), String> {
    Operation::parse(tool, args)
        .map(|_| ())
        .map_err(|e| e.code().into())
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
pub(super) struct Context {
    cancel: Arc<AtomicBool>,
    expired: Arc<AtomicBool>,
    epoch: u64,
    deadline: Instant,
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
impl Context {
    pub(super) fn check(&self) -> Result<(), Error> {
        if self.cancel.load(Ordering::SeqCst) || self.epoch != EPOCH.load(Ordering::SeqCst) {
            Err(Error::Cancelled)
        } else if self.expired.load(Ordering::SeqCst) || Instant::now() >= self.deadline {
            Err(Error::Timeout)
        } else {
            Ok(())
        }
    }

    pub(super) fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
static EPOCH: AtomicU64 = AtomicU64::new(0);
#[cfg(any(target_os = "windows", target_os = "macos"))]
static WORKER: Mutex<Option<SyncSender<Job>>> = Mutex::new(None);

pub fn reset() {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    EPOCH.fetch_add(1, Ordering::SeqCst);
}

#[cfg(target_os = "macos")]
pub fn session_unlocked() -> bool {
    macos::session_unlocked()
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
struct Job {
    operation: Operation,
    session: String,
    context: Context,
    reply: SyncSender<Result<Value, Error>>,
}

// COM and AX objects stay on this thread, including their destructors.
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn worker(receiver: Receiver<Job>) {
    #[cfg(target_os = "macos")]
    use macos::Backend;
    #[cfg(target_os = "windows")]
    use windows::Backend;
    let mut backend: Option<Backend> = None;
    let mut owner: Option<(String, u64)> = None;
    let mut observed: Option<Instant> = None;
    for job in receiver {
        let mutating = job.operation.mutating();
        let result = (|| {
            job.context.check()?;
            if backend.is_none() {
                backend = Some(Backend::new()?);
            }
            let native = backend.as_mut().ok_or(Error::ActionFailed)?;
            let identity = (job.session.clone(), job.context.epoch);
            if owner.as_ref() != Some(&identity) {
                native.reset();
                observed = None;
                owner = Some(identity);
            }
            if mutating && observed.is_none_or(|when| when.elapsed() > Duration::from_secs(120)) {
                return Err(Error::StaleRef);
            }
            let value = match &job.operation {
                Operation::Snapshot => {
                    native.reset();
                    observed = None;
                    let id = uuid::Uuid::new_v4().to_string();
                    let snapshot = native.snapshot(&job.context, &id)?;
                    let value = snapshot_value(snapshot)?;
                    observed = Some(Instant::now());
                    value
                }
                Operation::Click(reference) => {
                    native.click(reference, &job.context)?;
                    json!({"status":"ok"})
                }
                Operation::Type(reference, text) => {
                    native.type_text(reference, text, &job.context)?;
                    json!({"status":"ok"})
                }
                Operation::Press(keys) => {
                    native.press(keys, &job.context)?;
                    json!({"status":"ok"})
                }
            };
            job.context.check()?;
            Ok(value)
        })();
        if mutating || result.is_err() {
            if let Some(native) = backend.as_mut() {
                native.reset();
            }
            observed = None;
        }
        let _ = job.reply.send(result);
    }
}

#[cfg(any(target_os = "windows", target_os = "macos", test))]
fn snapshot_value(mut snapshot: Snapshot) -> Result<Value, Error> {
    // Reserve space beneath the bridge's 64 KiB result limit, including JSON escaping.
    fn trim(node: &mut Node, budget: &mut usize, truncated: &mut bool) {
        let name = crate::redact::redact(&node.name);
        node.name = name.chars().take(160).collect();
        node.role = node.role.chars().take(80).collect();
        *truncated |= node.name != name;
        let cost = 180 + node.reference.len() * 6 + node.role.len() * 6 + node.name.len() * 6;
        *budget = budget.saturating_sub(cost);
        node.children.retain_mut(|child| {
            if *budget < 2200 {
                *truncated = true;
                return false;
            }
            trim(child, budget, truncated);
            true
        });
    }
    trim(
        &mut snapshot.tree,
        &mut (58 * 1024),
        &mut snapshot.truncated,
    );
    let mut value = serde_json::to_value(snapshot).map_err(|_| Error::ActionFailed)?;
    value["status"] = json!("ok");
    if value.to_string().len() > 60 * 1024 {
        return Err(Error::ActionFailed);
    }
    Ok(value)
}

pub fn execute(call: &ToolCall, cancel: Arc<AtomicBool>) -> Result<Value, String> {
    let mutating = call.tool != "client.computer_snapshot";
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = cancel;
        Ok(Error::UnsupportedPlatform.response(mutating))
    }
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        let result = (|| {
            let operation = Operation::parse(&call.tool, &call.arguments)?;
            let context = Context {
                cancel,
                expired: Arc::new(AtomicBool::new(false)),
                epoch: EPOCH.load(Ordering::SeqCst),
                deadline: Instant::now() + Duration::from_secs(8),
            };
            context.check()?;
            let expired = context.expired.clone();
            let wait_cancel = context.cancel.clone();
            let epoch = context.epoch;
            let deadline = context.deadline;
            let (reply, result) = mpsc::sync_channel(1);
            let mut slot = WORKER.lock().map_err(|_| Error::ActionFailed)?;
            if slot.is_none() {
                let (sender, receiver) = mpsc::sync_channel(4);
                std::thread::Builder::new()
                    .name("neyra-computer".into())
                    .spawn(move || worker(receiver))
                    .map_err(|_| Error::ActionFailed)?;
                *slot = Some(sender);
            }
            let job = Job {
                operation,
                session: call.session_id.clone(),
                context,
                reply,
            };
            match slot.as_ref().ok_or(Error::ActionFailed)?.try_send(job) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) => return Err(Error::Timeout),
                Err(TrySendError::Disconnected(_)) => {
                    *slot = None;
                    return Err(Error::ActionFailed);
                }
            }
            drop(slot);
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    expired.store(true, Ordering::SeqCst);
                    return Err(Error::Timeout);
                }
                match result.recv_timeout(remaining.min(Duration::from_millis(25))) {
                    Ok(value) => return value,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return Err(Error::ActionFailed),
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                // The backend checks this same token before sending any native input.
                // Polling here also lets Stop return while a provider is unresponsive.
                if wait_cancel.load(Ordering::SeqCst) || EPOCH.load(Ordering::SeqCst) != epoch {
                    expired.store(true, Ordering::SeqCst);
                    return Err(Error::Cancelled);
                }
            }
        })();
        Ok(result.unwrap_or_else(|error| error.response(mutating)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> Snapshot {
        let id = "33333333-3333-4333-8333-333333333333";
        Snapshot {
            snapshot_id: id.into(),
            tree: Node {
                reference: format!("{id}:0"),
                role: "window".into(),
                name: "Редактор".into(),
                enabled: true,
                children: vec![Node {
                    reference: format!("{id}:1"),
                    role: "button".into(),
                    name: "Save".into(),
                    enabled: false,
                    children: vec![],
                }],
            },
            truncated: false,
        }
    }

    #[test]
    fn snapshot_json_round_trip_has_qualified_refs() {
        let snapshot = snapshot();
        let value = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(value["tree"]["ref"], format!("{}:0", snapshot.snapshot_id));
        assert_eq!(value["tree"]["children"][0]["enabled"], false);
        assert!(value["tree"].get("reference").is_none());
        assert_eq!(serde_json::from_value::<Snapshot>(value).unwrap(), snapshot);
    }

    #[test]
    fn snapshot_fits_bridge_limit_and_reports_truncation() {
        let mut snapshot = snapshot();
        let mut child = snapshot.tree.children[0].clone();
        child.name = "Я\\\"".repeat(500);
        snapshot.tree.children = vec![child; 512];
        let value = snapshot_value(snapshot).unwrap();
        assert_eq!(value["status"], "ok");
        assert_eq!(value["truncated"], true);
        assert!(value.to_string().len() < 64 * 1024);
    }

    #[test]
    fn native_errors_have_stable_codes_without_os_messages() {
        for (code, expected) in [
            (0x80070005u32, "permission_denied"),
            (0x80040201, "stale_ref"),
            (0x800705b4, "timeout"),
            (0x80070490, "not_found"),
            (0x80070057, "invalid_arguments"),
            (0x81234567, "action_failed"),
        ] {
            assert_eq!(Error::from_windows_hresult(code as i32).code(), expected);
        }
        for (code, expected) in [
            (-25202, "stale_ref"),
            (-25204, "timeout"),
            (-25211, "permission_denied"),
            (-25212, "not_found"),
            (-25201, "invalid_arguments"),
            (-25200, "action_failed"),
        ] {
            assert_eq!(Error::from_ax_error(code).code(), expected);
        }
        for error in [
            Error::StaleRef,
            Error::NotFound,
            Error::PermissionDenied,
            Error::UnsupportedPlatform,
            Error::Timeout,
            Error::Cancelled,
            Error::InvalidArguments,
            Error::ActionFailed,
        ] {
            let value = error.response(true);
            assert_eq!(value["code"], error.code());
            assert_eq!(value["retry"], false);
            assert!(value.get("message").is_none());
        }
        assert_eq!(Error::Timeout.response(true)["delivery"], "unknown");
        assert_eq!(Error::Timeout.response(false)["delivery"], "not_delivered");
        assert_eq!(Error::StaleRef.response(true)["delivery"], "not_delivered");
        let held_key = Error::ActionFailedNotDelivered.response(true);
        assert_eq!(held_key["code"], "action_failed");
        assert_eq!(held_key["delivery"], "not_delivered");
    }

    #[test]
    fn arguments_reject_extra_fields_and_unsafe_chords() {
        assert!(validate_arguments("client.computer_snapshot", &json!({})).is_ok());
        let reference = snapshot().tree.reference;
        assert!(validate_arguments(
            "client.computer_type",
            &json!({"ref":reference,"text":"Привет\n"})
        )
        .is_ok());
        for args in [
            json!({"keys":[]}),
            json!({"keys":["Ctrl"]}),
            json!({"keys":["a","Ctrl"]}),
            json!({"keys":["Ctrl","Control","a"]}),
            json!({"keys":"Ctrl+a"}),
            json!({"keys":["Enter"],"text":"never include in error"}),
        ] {
            assert_eq!(
                validate_arguments("client.computer_press", &args),
                Err("invalid_arguments".into())
            );
        }
        assert!(validate_arguments(
            "client.computer_press",
            &json!({"keys":["Cmd","Shift","a"]})
        )
        .is_ok());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    #[test]
    fn unsupported_tools_do_not_start_native_workers() {
        for tool in [
            "client.computer_snapshot",
            "client.computer_click",
            "client.computer_type",
            "client.computer_press",
        ] {
            let call = ToolCall {
                call_id: "unused".into(),
                device_id: "d".into(),
                session_id: "s".into(),
                tool: tool.into(),
                arguments: json!({}),
                deadline_ms: 0,
            };
            let value = execute(&call, Arc::new(AtomicBool::new(false))).unwrap();
            assert_eq!(value["code"], "unsupported_platform");
        }
    }
}
