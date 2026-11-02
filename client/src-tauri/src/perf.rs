//! Opt-in, content-free startup marks. File I/O stays on a dedicated writer thread.
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::Path,
    sync::{
        atomic::{AtomicU8, Ordering},
        mpsc::{self, SyncSender},
    },
    time::{Duration, Instant},
};

pub struct Startup(Option<Instant>);

impl Startup {
    pub fn from_env() -> Self {
        Self::new(std::env::var("NEYRA_PERF").ok().as_deref())
    }

    fn new(flag: Option<&str>) -> Self {
        Self((flag == Some("1")).then(Instant::now))
    }

    pub fn enabled(&self) -> bool {
        self.0.is_some()
    }

    pub fn setup_elapsed(&self) -> Option<Duration> {
        self.0.map(|start| start.elapsed())
    }

    pub fn attach(self, root: &Path, setup: Option<Duration>) -> Perf {
        Perf(self.0.and_then(|origin| {
            #[cfg(target_os = "linux")]
            let graphics_mode = Some(crate::storage::graphics_mode(root));
            #[cfg(not(target_os = "linux"))]
            let graphics_mode: Option<String> = None;
            let metadata = metadata(|key| std::env::var(key).ok(), graphics_mode.as_deref());
            let run_id = uuid::Uuid::new_v4().to_string();
            let (sender, receiver) = mpsc::sync_channel(8);
            let root = root.to_path_buf();
            // The five marks fit in the bounded channel even before the worker starts.
            std::thread::Builder::new()
                .name("neyra-perf".into())
                .spawn(move || {
                    for row in receiver.into_iter().take(5) {
                        write_record(&root, &row);
                    }
                })
                .ok()?;
            let recorder = Recorder {
                origin,
                metadata,
                run_id,
                sender,
                seen: AtomicU8::new(0),
            };
            recorder.record_at(Stage::Process, Duration::ZERO);
            recorder.record_at(Stage::RustSetup, setup.unwrap_or_default());
            Some(recorder)
        }))
    }
}

pub struct Perf(Option<Recorder>);
impl Perf {
    pub fn mark(&self, stage: Stage) {
        if let Some(recorder) = &self.0 {
            recorder.record_at(stage, recorder.origin.elapsed());
        }
    }
}

#[derive(Clone, Copy)]
pub enum Stage {
    Process,
    RustSetup,
    WebviewReady,
    FirstRender,
    Connected,
}
impl Stage {
    fn name(self) -> &'static str {
        match self {
            Self::Process => "process",
            Self::RustSetup => "rust_setup",
            Self::WebviewReady => "webview_ready",
            Self::FirstRender => "first_render",
            Self::Connected => "connected",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FrontendStage {
    WebviewReady,
    FirstRender,
}
impl From<FrontendStage> for Stage {
    fn from(stage: FrontendStage) -> Self {
        match stage {
            FrontendStage::WebviewReady => Self::WebviewReady,
            FrontendStage::FirstRender => Self::FirstRender,
        }
    }
}

struct Recorder {
    origin: Instant,
    metadata: Value,
    run_id: String,
    sender: SyncSender<Value>,
    seen: AtomicU8,
}
impl Recorder {
    fn record_at(&self, stage: Stage, elapsed: Duration) {
        let bit = 1 << stage as u8;
        if self.seen.fetch_or(bit, Ordering::Relaxed) & bit != 0 {
            return;
        }
        let mut row = self.metadata.clone();
        row["schema_version"] = json!(1);
        row["run_id"] = json!(self.run_id);
        row["stage"] = json!(stage.name());
        row["elapsed_ms"] = json!(elapsed.as_secs_f64() * 1000.0);
        // Instrumentation must never block startup or affect connection/UI error paths.
        let _ = self.sender.try_send(row);
    }
}

fn metadata(env: impl Fn(&str) -> Option<String>, graphics_mode: Option<&str>) -> Value {
    let graphics_mode = graphics_mode.filter(|mode| {
        matches!(
            *mode,
            "auto" | "wayland" | "wayland-nvidia" | "x11" | "compatibility"
        )
    });
    let forced = env("GDK_BACKEND").filter(|s| matches!(s.as_str(), "wayland" | "x11"));
    let session = env("XDG_SESSION_TYPE").filter(|s| matches!(s.as_str(), "wayland" | "x11"));
    let (backend, source) = if cfg!(target_os = "linux") {
        if graphics_mode.is_some_and(|mode| mode != "auto")
            && env("NEYRA_GRAPHICS_APPLIED").as_deref() == Some("1")
        {
            (forced.or(session), Some("graphics_setting"))
        } else if forced.is_some() {
            (forced, Some("gdk_backend"))
        } else if session.is_some() {
            (session, Some("session_type"))
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };
    let library_mode = env("NEYRA_LIBRARY_MODE")
        .filter(|s| matches!(s.as_str(), "bundled" | "system"))
        .or_else(|| {
            if env("APPIMAGE").is_some() || env("APPDIR").is_some() {
                Some("bundled".into())
            } else if cfg!(any(target_os = "linux", target_os = "windows")) {
                Some("system".into())
            } else {
                None
            }
        });
    json!({"os": std::env::consts::OS, "graphics_backend":backend, "graphics_backend_source":source, "graphics_mode":graphics_mode, "library_mode":library_mode})
}

fn write_record(root: &Path, row: &Value) {
    let dir = root.join("logs");
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("perf.jsonl");
    if !crate::logs::rotate(&path, |index| dir.join(format!("perf.jsonl.{index}"))) {
        return;
    }
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{row}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logs::{KEEP, MAX_BYTES};

    #[test]
    fn disabled_is_inert_and_only_exact_one_enables() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        for flag in [None, Some(""), Some("0"), Some("true"), Some("01")] {
            let startup = Startup::new(flag);
            assert!(!startup.enabled());
            assert!(startup.setup_elapsed().is_none());
            let perf = startup.attach(&root, None);
            assert!(perf.0.is_none());
            perf.mark(Stage::FirstRender);
        }
        assert!(!root.exists());
        assert!(Startup::new(Some("1")).enabled());
    }

    #[test]
    fn metadata_uses_fixed_values_without_paths_or_secrets() {
        let data = metadata(
            |key| match key {
                "GDK_BACKEND" => Some("x11".into()),
                "XDG_SESSION_TYPE" => Some("wayland".into()),
                "APPIMAGE" => Some("/private/path/app".into()),
                _ => None,
            },
            Some("/private/path/secret"),
        );
        assert_eq!(data["library_mode"], "bundled");
        if cfg!(target_os = "linux") {
            assert_eq!(data["graphics_backend"], "x11");
            assert_eq!(data["graphics_backend_source"], "gdk_backend");
        }
        assert!(data["graphics_mode"].is_null());
        assert!(!data.to_string().contains("private"));
        assert_eq!(
            metadata(
                |key| (key == "NEYRA_LIBRARY_MODE").then(|| "system".into()),
                None,
            )["library_mode"],
            "system"
        );
        assert!(metadata(|_| None, None)["graphics_backend"].is_null());
        for mode in ["auto", "wayland", "wayland-nvidia", "x11", "compatibility"] {
            assert_eq!(metadata(|_| None, Some(mode))["graphics_mode"], mode);
        }
        for mode in [None, Some(""), Some("unknown"), Some("Compatibility")] {
            assert!(metadata(|_| None, mode)["graphics_mode"].is_null());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn graphics_settings_distinguish_compatibility_and_nvidia_on_wayland() {
        for (mode, forced) in [("compatibility", None), ("wayland-nvidia", Some("wayland"))] {
            let data = metadata(
                |key| match key {
                    "GDK_BACKEND" => forced.map(str::to_owned),
                    "XDG_SESSION_TYPE" => Some("wayland".into()),
                    "NEYRA_GRAPHICS_APPLIED" => Some("1".into()),
                    _ => None,
                },
                Some(mode),
            );
            assert_eq!(data["graphics_backend"], "wayland");
            assert_eq!(data["graphics_backend_source"], "graphics_setting");
            assert_eq!(data["graphics_mode"], mode);
        }
        let auto = metadata(
            |key| match key {
                "XDG_SESSION_TYPE" => Some("wayland".into()),
                "NEYRA_GRAPHICS_APPLIED" => Some("true".into()),
                _ => None,
            },
            Some("auto"),
        );
        assert_eq!(auto["graphics_backend"], "wayland");
        assert_eq!(auto["graphics_backend_source"], "session_type");
        assert_eq!(auto["graphics_mode"], "auto");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn inherited_graphics_marker_requires_an_explicit_recovery_mode() {
        for mode in [Some("auto"), None, Some("unknown")] {
            for forced in [None, Some("x11")] {
                let data = metadata(
                    |key| match key {
                        "GDK_BACKEND" => forced.map(str::to_owned),
                        "XDG_SESSION_TYPE" => Some("wayland".into()),
                        "NEYRA_GRAPHICS_APPLIED" => Some("1".into()),
                        _ => None,
                    },
                    mode,
                );
                assert_eq!(data["graphics_backend"], forced.unwrap_or("wayland"));
                assert_eq!(
                    data["graphics_backend_source"],
                    if forced.is_some() {
                        "gdk_backend"
                    } else {
                        "session_type"
                    }
                );
                assert_eq!(
                    data["graphics_mode"],
                    if mode == Some("auto") {
                        json!("auto")
                    } else {
                        Value::Null
                    }
                );
            }
        }
    }

    #[test]
    fn stages_are_monotonic_content_free_and_once_per_run() {
        let (sender, receiver) = mpsc::sync_channel(8);
        let recorder = Recorder {
            origin: Instant::now(),
            metadata: metadata(|_| None, None),
            run_id: uuid::Uuid::new_v4().to_string(),
            sender,
            seen: AtomicU8::new(0),
        };
        for (index, stage) in [
            Stage::Process,
            Stage::RustSetup,
            Stage::WebviewReady,
            Stage::FirstRender,
            Stage::Connected,
        ]
        .into_iter()
        .enumerate()
        {
            recorder.record_at(stage, Duration::from_millis(index as u64 * 10));
            recorder.record_at(stage, Duration::from_secs(1));
        }
        drop(recorder);
        let rows: Vec<_> = receiver.into_iter().collect();
        assert_eq!(rows.len(), 5);
        assert_eq!(rows[0]["elapsed_ms"], 0.0);
        assert_eq!(rows[4]["elapsed_ms"], 40.0);
        assert_eq!(rows[4]["stage"], "connected");
        for row in &rows {
            assert_eq!(row["run_id"], rows[0]["run_id"]);
            assert_eq!(row["schema_version"], 1);
            assert_eq!(row.as_object().unwrap().len(), 9);
        }
    }

    #[test]
    fn enabled_pipeline_writes_all_five_stages_off_thread() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(root.join("settings")).unwrap();
        fs::write(
            root.join("settings/app.json"),
            r#"{"graphics_mode":"compatibility"}"#,
        )
        .unwrap();
        let startup = Startup::new(Some("1"));
        let setup = startup.setup_elapsed();
        let perf = startup.attach(&root, setup);
        assert!(perf.0.is_some());
        for stage in [Stage::WebviewReady, Stage::FirstRender, Stage::Connected] {
            perf.mark(stage);
            perf.mark(stage);
        }
        drop(perf);
        let deadline = Instant::now() + Duration::from_secs(2);
        let rows = loop {
            let content = fs::read_to_string(root.join("logs/perf.jsonl")).unwrap_or_default();
            let rows: Vec<Value> = content
                .lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect();
            if rows.len() == 5 {
                break rows;
            }
            assert!(
                Instant::now() < deadline,
                "perf writer did not finish: {content}"
            );
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(
            rows.iter()
                .map(|row| row["stage"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "process",
                "rust_setup",
                "webview_ready",
                "first_render",
                "connected"
            ]
        );
        assert!(rows
            .windows(2)
            .all(|pair| pair[0]["elapsed_ms"].as_f64().unwrap()
                <= pair[1]["elapsed_ms"].as_f64().unwrap()));
        for row in &rows {
            if cfg!(target_os = "linux") {
                assert_eq!(row["graphics_mode"], "compatibility");
            } else {
                assert!(row["graphics_mode"].is_null());
            }
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn writer_rotates_and_io_failure_is_nonfatal() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(root.join("logs")).unwrap();
        let path = root.join("logs/perf.jsonl");
        for _ in 0..KEEP + 2 {
            fs::write(&path, vec![b'x'; MAX_BYTES as usize]).unwrap();
            write_record(&root, &json!({"stage":"process"}));
        }
        assert_eq!(fs::read_dir(root.join("logs")).unwrap().count(), KEEP + 1);
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\"stage\":\"process\"}\n"
        );
        let blocked = root.join("file");
        fs::write(&blocked, "").unwrap();
        write_record(&blocked, &json!({}));
        fs::remove_dir_all(root).unwrap();
    }
}
