mod appimage_env;
mod audio;
mod audit;
mod character;
mod chat_dispatch;
mod command_runner;
mod commands;
mod computer;
mod files;
mod host;
mod logs;
mod perf;
mod policy;
mod redact;
mod screen;
mod shell;
mod storage;
mod updater;
mod voice;
mod wake;

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use policy::{Decision, ToolCall};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use storage::{Profile, Settings};
use tauri::{Emitter, Manager, State};
use tokio::sync::mpsc::{self, UnboundedSender};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};

type SocketSender = UnboundedSender<Message>;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const WRITE_TIMEOUT: Duration = Duration::from_secs(15);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(75);

async fn socket_send<S: futures_util::Sink<Message> + Unpin>(
    socket: &mut S,
    message: Message,
) -> Result<(), ()> {
    tokio::time::timeout(WRITE_TIMEOUT, socket.send(message))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}

async fn run_socket_pair<F: std::future::Future<Output = &'static str>>(
    mut workers: futures_util::stream::FuturesUnordered<F>,
) -> Option<&'static str> {
    // Failure drops the sibling; an orderly stop lets both flush Close.
    let reason = workers.next().await;
    if reason == Some("closed") {
        let _ = tokio::time::timeout(WRITE_TIMEOUT, async {
            while workers.next().await.is_some() {}
        })
        .await;
    }
    reason
}

/// Set when the server reports that this device was revoked for a given profile,
/// so the next manual connect for that profile can include reauth.
static REVOKED_PROFILES: Mutex<Option<std::collections::HashSet<String>>> = Mutex::new(None);

fn record_revoked_seen(profile_id: &str) {
    let mut guard = REVOKED_PROFILES.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .get_or_insert_with(std::collections::HashSet::new)
        .insert(profile_id.to_string());
}

fn clear_revoked_seen(profile_id: &str) {
    let mut guard = REVOKED_PROFILES.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(set) = guard.as_mut() {
        set.remove(profile_id);
    }
}

fn is_revoked_seen(profile_id: &str) -> bool {
    let guard = REVOKED_PROFILES.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .as_ref()
        .map(|s| s.contains(profile_id))
        .unwrap_or(false)
}

#[cfg(test)]
fn clear_all_revoked_seen() {
    let mut guard = REVOKED_PROFILES.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(set) = guard.as_mut() {
        set.clear();
    }
}

/// Computes SHA-256 hex digest to safely scope filenames per profile without
/// path traversal, illegal characters, or leaking profile identifiers into the filesystem.
fn profile_hash(profile_id: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(profile_id.as_bytes()))
}

/// Revocation marker path scoped strictly to the profile's cryptographic hash.
fn revoked_marker(root: &std::path::Path, profile_id: &str) -> PathBuf {
    let hash = profile_hash(profile_id);
    root.join(format!("device-revoked-{hash}"))
}

fn mark_revoked(root: &std::path::Path, profile_id: &str) -> Result<(), String> {
    record_revoked_seen(profile_id);
    std::fs::create_dir_all(root).map_err(|e| format!("Не удалось создать папку данных: {e}"))?;
    std::fs::write(revoked_marker(root, profile_id), b"revoked\n")
        .map_err(|e| format!("Не удалось сохранить метку отзыва: {e}"))
}

fn clear_revoked(root: &std::path::Path, profile_id: &str) -> Result<(), String> {
    clear_revoked_seen(profile_id);
    let marker = revoked_marker(root, profile_id);
    if marker.exists() {
        std::fs::remove_file(&marker)
            .map_err(|e| format!("Не удалось удалить метку отзыва: {e}"))?;
    }
    Ok(())
}

/// A revoke reported for this profile in this process or left on disk by a previous run.
fn revoked_pending(root: &std::path::Path, profile_id: &str) -> bool {
    is_revoked_seen(profile_id) || revoked_marker(root, profile_id).exists()
}

pub struct Desktop {
    root: PathBuf,
    settings: Mutex<Settings>,
    bridge: Mutex<Option<SocketSender>>,
    voice: Mutex<Option<SocketSender>>,
    active_profile: Mutex<Option<String>>,
    seen: Mutex<HashMap<String, u64>>,
    pending: Mutex<HashMap<String, ToolCall>>,
    cancelled: Mutex<Arc<AtomicBool>>,
    generation: Arc<AtomicU64>,
    recording: Mutex<Option<audio::Recording>>,
    epoch: AtomicU64,
    transport: Mutex<()>,
    audit_lock: Mutex<()>,
    shortcuts: AtomicBool,
    screen_locked: AtomicBool,
    current_turn: Mutex<Option<String>>,
    chat_dispatch: chat_dispatch::ChatDispatch,
    commands: Mutex<commands::Store>,
    waiters: Mutex<HashMap<String, tokio::sync::oneshot::Sender<Value>>>,
    drafts: Mutex<HashMap<String, commands::Command>>,
    hotkeys: Mutex<HashMap<u32, (String, tauri_plugin_global_shortcut::Shortcut)>>,
    hotkey_backend: AtomicBool,
    running: Mutex<Option<String>>,
    pending_import: Mutex<Option<command_runner::PendingImport>>,
    recoveries: Mutex<Vec<storage::Recovery>>,
    /// Set after a data-folder move. Further writes stay on the old folder until restart, so they are refused.
    relocated: AtomicBool,
    pending_data_move: Mutex<Option<command_runner::PendingDataMove>>,
    /// Local actions still running after a quick-command step stopped waiting.
    local_inflight: AtomicUsize,
    local_cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    output_device: Arc<Mutex<String>>,
    player: audio::Player,
    segments: Mutex<voice::Segments>,
    live: Mutex<Option<Live>>,
    live_run: AtomicU64,
}
struct Live {
    capture: audio::LiveCapture,
    stop: Arc<AtomicBool>,
    run: u64,
    worker: Option<std::thread::JoinHandle<()>>,
}
fn with_run(mut value: Value, run: u64) -> Value {
    if let Some(obj) = value.as_object_mut() {
        obj.insert("run".into(), json!(run));
    }
    value
}
fn release_live(mut live: Live) {
    live.stop.store(true, Ordering::SeqCst);
    drop(live.capture);
    if let Some(worker) = live.worker.take() {
        let _ = worker.join();
    }
}
fn lock_error<T>(_: std::sync::PoisonError<T>) -> String {
    "Внутренняя ошибка состояния".into()
}
fn config_error(message: impl std::fmt::Display) -> String {
    format!("CONFIG_ERROR: {message}")
}
fn send(sender: &Mutex<Option<SocketSender>>, value: Value) -> Result<(), String> {
    let guard = sender.lock().map_err(lock_error)?;
    guard
        .as_ref()
        .ok_or("Нет подключения")?
        .send(Message::Text(value.to_string().into()))
        .map_err(|_| "Подключение закрыто".into())
}
fn profile(state: &Desktop, id: &str) -> Result<Profile, String> {
    state
        .settings
        .lock()
        .map_err(lock_error)?
        .profiles
        .iter()
        .find(|p| p.id == id)
        .cloned()
        .ok_or_else(|| "Профиль не найден".into())
}
fn server_url(profile: &Profile, path: &str) -> Result<url::Url, String> {
    let mut u = url::Url::parse(&profile.url).map_err(|_| "Неверный адрес сервера")?;
    if !matches!(u.scheme(), "http" | "https")
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return Err("Неверный адрес сервера".into());
    }
    if u.scheme() == "http" && !matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")) {
        return Err("Удалённый сервер требует HTTPS".into());
    }
    let (clean_path, query) = match path.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (path, None),
    };
    u.set_path(&format!("{}{}", u.path().trim_end_matches('/'), clean_path));
    if let Some(q) = query {
        u.set_query(Some(q));
    }
    Ok(u)
}

fn manifest(state: &Desktop, p: &Profile) -> Result<Value, String> {
    let s = state.settings.lock().map_err(lock_error)?;
    let platform = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if std::env::var("XDG_SESSION_TYPE").unwrap_or_default() == "wayland" {
        "linux-wayland"
    } else {
        "linux-x11"
    };
    // Runtime-only: names, trigger texts and tool names. Never arguments, paths or regexes.
    let command_info = state
        .commands
        .lock()
        .map(|c| commands::manifest_info(c.entries()))
        .unwrap_or_default();
    Ok(
        json!({"protocol":"neyra.desktop.v1","device_id":s.device_id,"session_id":p.session_id,"name":s.device_name,"platform":platform,"tools":if state.screen_locked.load(Ordering::SeqCst){vec![]}else{policy::capabilities(&s.permissions)},"commands":command_info,"features":["command_drafts"]}),
    )
}

#[tauri::command]
fn load_settings(state: State<'_, Desktop>) -> Result<Value, String> {
    let s = state.settings.lock().map_err(lock_error)?;
    let recoveries = state.recoveries.lock().map_err(lock_error)?.clone();
    Ok(
        json!({"settings":*s,"data_root":state.root,"platform":std::env::consts::OS,"version":env!("CARGO_PKG_VERSION"),"global_shortcuts":state.shortcuts.load(Ordering::SeqCst),"hotkeys_available":state.hotkey_backend.load(Ordering::SeqCst),"pc_access_available":!state.screen_locked.load(Ordering::SeqCst),"recoveries":recoveries,"screen_backend":screen::screen_available(),"input_backend":screen::input_available()}),
    )
}
#[tauri::command]
async fn save_settings(
    app: tauri::AppHandle,
    state: State<'_, Desktop>,
    settings: Settings,
) -> Result<(), String> {
    apply_settings(&app, &state, settings)
}

pub(crate) fn apply_settings(
    app: &tauri::AppHandle,
    state: &Desktop,
    settings: Settings,
) -> Result<(), String> {
    if state.relocated.load(Ordering::SeqCst) {
        return Err(
            "Папка данных сменится после перезапуска. До перезапуска сохранение отключено.".into(),
        );
    }
    let old = state.settings.lock().map_err(lock_error)?.clone();
    if settings.schema_version != storage::SETTINGS_VERSION
        || settings.device_id != old.device_id
        || settings.profiles.len() > 12
        || settings.device_name.len() > 80
        || settings.device_name.trim().is_empty()
        || !storage::valid_theme(&settings.theme)
        || !(1..=365).contains(&settings.audit_days)
        || !matches!(
            settings.graphics_mode.as_str(),
            "auto" | "wayland" | "wayland-nvidia" | "x11" | "compatibility"
        )
    {
        return Err("Неверные настройки".into());
    }
    settings.voice.validate()?;
    if settings.voice != old.voice {
        live_stop_inner(state)?;
    }
    if settings.permissions.web_domains.len() > 50
        || settings.permissions.apps.len() > 200
        || settings.permissions.fs_roots.len() > 20
    {
        return Err("Слишком большой allowlist".into());
    }
    for root in &settings.permissions.fs_roots {
        files::validate_root(root, &state.root)?;
    }
    if (settings.permissions.screen_auto && !settings.permissions.screen)
        || (settings.permissions.files && settings.permissions.fs_roots.is_empty())
    {
        return Err("Сначала включите снимки экрана / добавьте папку".into());
    }
    for domain in &settings.permissions.web_domains {
        let url = policy::web_url(&format!("https://{domain}"))?;
        if url.host_str() != Some(domain.as_str()) || url.path() != "/" || url.port().is_some() {
            return Err("Укажите домен без пути и порта".into());
        }
    }
    for p in &settings.profiles {
        uuid::Uuid::parse_str(&p.id).map_err(|_| "Неверный профиль")?;
        uuid::Uuid::parse_str(&p.session_id).map_err(|_| "Неверная сессия")?;
        server_url(p, "/v1/health")?;
    }
    if !settings.active_profile.is_empty()
        && !settings
            .profiles
            .iter()
            .any(|p| p.id == settings.active_profile)
    {
        return Err("Неверный профиль".into());
    }
    let changed = serde_json::to_value(&old.permissions).ok()
        != serde_json::to_value(&settings.permissions).ok();
    let screen_changed = (old.permissions.screen, old.permissions.input)
        != (settings.permissions.screen, settings.permissions.input);
    let retention_changed = settings.audit_days != old.audit_days;
    let audit_days = settings.audit_days;
    save_settings_and_prune(
        &state.root,
        &state.audit_lock,
        retention_changed.then_some(audit_days),
        || storage::save(&state.root, &settings),
        || {
            character::refresh_overlay_after_settings_save(app, settings.character_enabled);
            if settings.theme != old.theme {
                let _ = app.emit("theme-changed", json!({ "theme": settings.theme }));
            }
            *state.settings.lock().map_err(lock_error)? = settings.clone();
            if let Ok(mut dev) = state.output_device.lock() {
                *dev = settings.voice.output_device.clone();
            }
            Ok(())
        },
    )?;
    if changed {
        stop_inner(state)?;
        if screen_changed {
            screen::reset();
        }
        send_capabilities(state);
    }
    Ok(())
}

fn save_settings_and_prune(
    root: &std::path::Path,
    audit_lock: &Mutex<()>,
    audit_days: Option<u32>,
    save: impl FnOnce() -> Result<(), String>,
    after_save: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    save()?;
    after_save()?;
    if let Some(days) = audit_days {
        match audit_lock.lock() {
            Ok(_guard) => prune_after_settings_save(root, days),
            Err(_) => logs::log(
                root,
                "warn",
                "audit prune after settings save skipped: audit lock poisoned",
            ),
        }
    }
    Ok(())
}

fn prune_after_settings_save(root: &std::path::Path, audit_days: u32) {
    if let Err(error) = audit::prune(root, audit_days) {
        logs::log(
            root,
            "warn",
            &format!("audit prune after settings save failed: {error}"),
        );
    }
}

/// Refreshes the server's runtime view (tools and quick-command names) when a bridge is connected.
fn send_capabilities(state: &Desktop) {
    let Ok(Some(id)) = state.active_profile.lock().map(|p| p.clone()) else {
        return;
    };
    if let Ok(p) = profile(state, &id) {
        if let Ok(manifest) = manifest(state, &p) {
            let _ = send(
                &state.bridge,
                json!({"type":"capabilities","manifest":manifest}),
            );
        }
    }
}
#[tauri::command]
fn store_token(state: State<'_, Desktop>, profile_id: String, token: String) -> Result<(), String> {
    profile(&state, &profile_id)?;
    storage::store_token(&storage::secret(&profile_id)?, &token)
}

#[tauri::command]
async fn api(
    state: State<'_, Desktop>,
    profile_id: String,
    path: String,
    method: String,
) -> Result<Value, String> {
    let route_path = path.split_once('?').map(|(p, _)| p).unwrap_or(&path);
    let allowed = matches!(
        (method.as_str(), route_path),
        (
            "GET",
            "/v1/health" | "/v1/status" | "/v1/plugins" | "/openapi.json" | "/v1/logs"
        ) | ("POST", "/v1/system/restart")
    );
    if !allowed {
        return Err("API-действие недоступно".into());
    }

    let p = profile(&state, &profile_id)?;
    let url = server_url(&p, &path)?;
    let token = storage::load_token(&storage::secret(&profile_id)?)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| "Ошибка сетевого клиента")?;
    let verb = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "Неверный метод")?;
    let response = client
        .request(verb, url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "Сервер недоступен; проверьте адрес и сеть")?;
    if !response.status().is_success() {
        return Err(format!("Сервер вернул HTTP {}", response.status().as_u16()));
    }
    response
        .json()
        .await
        .map_err(|_| "Сервер вернул неверный ответ".into())
}

#[tauri::command]
async fn set_module(
    state: State<'_, Desktop>,
    profile_id: String,
    module_id: String,
    enabled: bool,
) -> Result<Value, String> {
    if module_id.is_empty()
        || module_id.len() > 80
        || !module_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("Неверный модуль".into());
    }
    let p = profile(&state, &profile_id)?;
    let token = storage::load_token(&storage::secret(&profile_id)?)?;
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| "Ошибка сети")?
        .patch(server_url(&p, &format!("/v1/plugins/{module_id}"))?)
        .bearer_auth(token)
        .json(&json!({"enabled":enabled}))
        .send()
        .await
        .map_err(|_| "Сервер недоступен")?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    response.json().await.map_err(|_| "Неверный ответ".into())
}

#[tauri::command]
async fn connect(
    app: tauri::AppHandle,
    state: State<'_, Desktop>,
    profile_id: String,
) -> Result<(), String> {
    let epoch = {
        let _guard = state.transport.lock().map_err(lock_error)?;
        state.epoch.load(Ordering::SeqCst)
    };
    let p = profile(&state, &profile_id).map_err(config_error)?;
    let token = storage::load_token(&storage::secret(&profile_id).map_err(config_error)?)
        .map_err(config_error)?;
    let hello = manifest(&state, &p)?;
    // After a revoke the person reconnects by hand; that explicit attempt carries the reauth header.
    let root = state.root.clone();
    let reauth = revoked_pending(&root, &profile_id);
    let sockets = connect_sockets_with(&p, &token, &hello, CONNECT_TIMEOUT, reauth).await?;
    install_connected_sockets(&state.transport, &state.epoch, epoch, sockets, |sockets| {
        apply_connection_install(&root, &profile_id, reauth, || {
            disconnect_locked(&state)?;
            let epoch = state.epoch.load(Ordering::SeqCst);
            *state.active_profile.lock().map_err(lock_error)? = Some(profile_id.clone());
            start_socket_workers(app, &state, sockets.take().unwrap(), epoch, &profile_id)
        })
    })
    .await
}

type ClientSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn close_sockets(sockets: Vec<(ClientSocket, &'static str)>) {
    futures_util::future::join_all(sockets.into_iter().map(|(mut socket, _)| async move {
        let _ = socket_send(&mut socket, Message::Close(None)).await;
    }))
    .await;
}

/// Applies a person-initiated reauth connection in a safe order: the fallible
/// revoke-marker removal runs before any live transport state is mutated, so a
/// failure leaves the previous connection and the marker intact instead of
/// leaving an active profile without socket workers.
fn apply_connection_install(
    root: &std::path::Path,
    profile_id: &str,
    reauth: bool,
    install: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if reauth {
        clear_revoked(root, profile_id)?;
    }
    install()
}

async fn install_connected_sockets(
    transport: &Mutex<()>,
    current_epoch: &AtomicU64,
    epoch: u64,
    sockets: Vec<(ClientSocket, &'static str)>,
    install: impl FnOnce(&mut Option<Vec<(ClientSocket, &'static str)>>) -> Result<(), String>,
) -> Result<(), String> {
    let mut sockets = Some(sockets);
    let result = (|| {
        let _guard = transport.lock().map_err(lock_error)?;
        if current_epoch.load(Ordering::SeqCst) != epoch {
            return Err("Подключение отменено".into());
        }
        install(&mut sockets)
    })();
    // Cancellation and install failures must flush Close without retaining the
    // synchronous transport lock; a socket the install step did not take is
    // still ours to close.
    if let Some(sockets) = sockets {
        close_sockets(sockets).await;
    }
    result
}

#[cfg(test)]
async fn connect_sockets(
    p: &Profile,
    token: &str,
    hello: &Value,
    timeout: Duration,
) -> Result<Vec<(ClientSocket, &'static str)>, String> {
    connect_sockets_with(p, token, hello, timeout, false).await
}

async fn connect_sockets_with(
    p: &Profile,
    token: &str,
    hello: &Value,
    timeout: Duration,
    reauth: bool,
) -> Result<Vec<(ClientSocket, &'static str)>, String> {
    let mut sockets = Vec::new();
    let result: Result<(), String> = async {
        for (path, kind) in [
            ("/v1/desktop/bridge", "bridge"),
            ("/v1/desktop/voice", "voice"),
        ] {
            let mut url = server_url(p, path).map_err(config_error)?;
            let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
            url.set_scheme(scheme)
                .map_err(|_| config_error("Неверный адрес"))?;
            let mut request = url
                .as_str()
                .into_client_request()
                .map_err(|_| config_error("Неверный адрес"))?;
            request.headers_mut().insert(
                "Authorization",
                format!("Bearer {token}")
                    .parse()
                    .map_err(|_| config_error("Неверный токен"))?,
            );
            if reauth {
                request.headers_mut().insert(
                    "x-neyra-reauth",
                    "1".parse()
                        .map_err(|_| config_error("Неверный заголовок"))?,
                );
            }
            let (ws, _) = tokio::time::timeout(timeout, connect_async(request))
                .await
                .map_err(|_| "Сервер не ответил")?
                .map_err(|error| match error {
                    tokio_tungstenite::tungstenite::Error::Http(response)
                        if matches!(response.status().as_u16(), 401 | 403) =>
                    {
                        "AUTH_REJECTED"
                    }
                    _ => "Подключение отклонено; проверьте токен и версию сервера",
                })?;
            sockets.push((ws, kind));
            socket_send(
                &mut sockets.last_mut().unwrap().0,
                Message::Text(hello.to_string().into()),
            )
            .await
            .map_err(|_| "Подключение закрыто")?;
        }
        Ok(())
    }
    .await;
    if let Err(error) = result {
        close_sockets(sockets).await;
        return Err(error);
    }
    Ok(sockets)
}

fn start_socket_workers(
    app: tauri::AppHandle,
    state: &Desktop,
    sockets: Vec<(ClientSocket, &'static str)>,
    epoch: u64,
    profile_id: &str,
) -> Result<(), String> {
    let workers = futures_util::stream::FuturesUnordered::new();
    for (ws, kind) in sockets {
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        if kind == "bridge" {
            *state.bridge.lock().map_err(lock_error)? = Some(tx);
        } else {
            *state.voice.lock().map_err(lock_error)? = Some(tx);
        }
        let handle = app.clone();
        let revoked_root = state.root.clone();
        let revoked_profile = profile_id.to_string();
        workers.push(async move {
            socket_worker(
                ws,
                &mut rx,
                (Duration::from_secs(30), HEARTBEAT_TIMEOUT),
                || handle.state::<Desktop>().epoch.load(Ordering::SeqCst) == epoch,
                |mut packet| {
                    if let Some(object) = packet.as_object_mut() {
                        object.insert("source".into(), json!(kind));
                    }
                    if let Some(request_id) = packet["request_id"].as_str() {
                        let state = handle.state::<Desktop>();
                        let current = state.current_turn.lock().ok().and_then(|t| t.clone());
                        if current.as_deref() != Some(request_id) {
                            return true;
                        }
                        if packet["type"] == "error"
                            || packet["type"] == "cancelled"
                            || packet["type"] == "audio.done"
                            || packet["type"] == "command_match"
                            || (kind == "bridge" && packet["type"] == "done")
                        {
                            if let Ok(mut t) = state.current_turn.lock() {
                                *t = None;
                            }
                        }
                    }
                    match packet["type"].as_str() {
                        Some("hello") => {
                            if kind == "bridge" {
                                handle.state::<perf::Perf>().mark(perf::Stage::Connected);
                            }
                            let _ = handle.emit("desktop-event", packet);
                        }
                        Some("pong") => {
                            let _ = handle.emit("desktop-event", packet);
                        }
                        Some("client_tool_call") => {
                            let mut data = packet.clone();
                            if let Some(o) = data.as_object_mut() {
                                o.remove("type");
                                o.remove("protocol");
                                o.remove("source");
                            }
                            if let Ok(call) = serde_json::from_value::<ToolCall>(data) {
                                receive_call(handle.clone(), call);
                            }
                        }
                        Some("command_draft") => {
                            if kind == "bridge" {
                                command_runner::receive_draft(&handle, &packet);
                            }
                        }
                        Some("command_match") => {
                            // Only the authenticated voice socket may ask for a local command; the name is looked up locally.
                            if kind == "voice" {
                                if let Some(name) = packet["name"].as_str() {
                                    command_runner::run_by_name(
                                        handle.clone(),
                                        name.to_string(),
                                        "voice",
                                    );
                                }
                            }
                            let _ = handle.emit("desktop-event", packet);
                        }
                        Some("cancel") => {
                            // Per-call cancel must not become global Stop (AR-3).
                            let state = handle.state::<Desktop>();
                            if let Some(call_id) = packet["call_id"].as_str() {
                                if let Ok(mut pending) = state.pending.lock() {
                                    if let Some(call) = pending.remove(call_id) {
                                        drop(pending);
                                        reply(
                                            &handle,
                                            &call,
                                            json!({"status":"denied","code":"cancelled"}),
                                            false,
                                        );
                                        let _ = handle.emit(
                                            "host-confirm-closed",
                                            json!({"call_id":call.call_id}),
                                        );
                                    }
                                }
                            }
                        }
                        Some("audio.chunk" | "audio.segment" | "audio.done") => {
                            if !reply_audio(&handle, &packet) {
                                return false;
                            }
                        }
                        Some("voice.conversion") => {
                            // Stop policy: stop speaking now; the turn ends with conversion_failed.
                            if packet["status"] == "stopped" {
                                handle
                                    .state::<Desktop>()
                                    .generation
                                    .fetch_add(1, Ordering::SeqCst);
                            }
                            let _ = handle.emit("desktop-event", packet);
                        }
                        Some("cancelled") => {
                            if let Ok(mut s) = handle.state::<Desktop>().segments.lock() {
                                s.reset(None);
                            }
                            let _ = handle.emit("desktop-event", packet);
                        }
                        _ => {
                            let _ = handle.emit("desktop-event", packet);
                        }
                    }
                    true
                },
                move || {
                    if let Err(err) = mark_revoked(&revoked_root, &revoked_profile) {
                        eprintln!("Neyra: failed to mark revoked: {err}");
                    }
                },
            )
            .await
        });
    }
    tauri::async_runtime::spawn(async move {
        let reason = run_socket_pair(workers).await.unwrap_or("transport");
        let state = app.state::<Desktop>();
        let Ok(_guard) = state.transport.lock() else {
            return;
        };
        if state.epoch.load(Ordering::SeqCst) == epoch {
            let _ = disconnect_locked(&state);
            let _ = app.emit(
                "desktop-event",
                json!({"type":"disconnected", "reason":reason}),
            );
        }
    });
    Ok(())
}

async fn socket_worker<S>(
    ws: tokio_tungstenite::WebSocketStream<S>,
    rx: &mut mpsc::UnboundedReceiver<Message>,
    timing: (Duration, Duration),
    is_current: impl Fn() -> bool,
    mut on_packet: impl FnMut(Value) -> bool,
    on_revoked: impl Fn(),
) -> &'static str
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut writer, mut reader) = ws.split();
    let mut heartbeat = tokio::time::interval(timing.0);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut pong_deadline = None;
    let mut reason = "transport";
    loop {
        if !is_current() {
            reason = "closed";
            break;
        }
        if pong_deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
            break;
        }
        tokio::select! {
            _ = async {
                match pong_deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending().await,
                }
            } => break,
            message = rx.recv() => match message {
                Some(message) => if socket_send(&mut writer, message).await.is_err() { break; },
                None => { reason = "closed"; break; },
            },
            _ = heartbeat.tick() => {
                if socket_send(&mut writer, Message::Text(json!({"type":"ping"}).to_string().into())).await.is_err() {
                    break;
                }
                // Only the first outstanding ping starts the response deadline.
                pong_deadline.get_or_insert(tokio::time::Instant::now() + timing.1);
            },
            message = reader.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    if !is_current() { reason = "closed"; break; }
                    if text.len() > 100000 { break; }
                    let Ok(packet) = serde_json::from_str::<Value>(&text) else { break; };
                    if packet["type"] == "revoked" {
                        on_revoked();
                        reason = "auth";
                        break;
                    }
                    if packet["type"] == "pong" { pong_deadline = None; }
                    if !on_packet(packet) { break; }
                },
                Some(Ok(Message::Ping(bytes))) => {
                    if socket_send(&mut writer, Message::Pong(bytes)).await.is_err() { break; }
                },
                Some(Ok(Message::Close(Some(frame)))) if frame.reason == "revoked" => {
                    // A revoked device may be closed without a packet.
                    on_revoked();
                    reason = "auth";
                    break;
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {},
            },
        }
    }
    if reason == "closed" {
        let _ = socket_send(&mut writer, Message::Close(None)).await;
    }
    reason
}

/// Reply audio from the voice socket. Returns false on a protocol violation (close socket).
fn reply_audio(app: &tauri::AppHandle, packet: &Value) -> bool {
    let state = app.state::<Desktop>();
    let request = packet["request_id"].as_str().unwrap_or_default();
    let seq = packet["seq"].as_u64();
    let generation = state.generation.load(Ordering::SeqCst);
    let Ok(mut segments) = state.segments.lock() else {
        return false;
    };
    let finished = match packet["type"].as_str() {
        Some("audio.chunk") => {
            let Some(bytes) = packet["data"]
                .as_str()
                .and_then(|d| base64::engine::general_purpose::STANDARD.decode(d).ok())
            else {
                return false;
            };
            // Out-of-order or oversized chunks are late packets of a replaced turn: drop them.
            segments.chunk(request, seq, &bytes);
            return true;
        }
        Some("audio.segment") => segments.finish(request, seq),
        // PTT sends one WAV without numbers and closes it with audio.done.
        _ => segments.finish(request, None),
    };
    drop(segments);
    if let Some((number, bytes)) = finished {
        character::emit_mouth(app, &bytes);
        if state.player.segment(generation, number, bytes).is_err() {
            let _ = stop_inner(&state);
            let _ = app.emit(
                "desktop-event",
                json!({"type":"error","code":"audio_backpressure"}),
            );
            return true;
        }
    }
    if packet["type"] == "audio.done" {
        state.player.done(generation);
    }
    true
}

fn wake_dir(state: &Desktop) -> PathBuf {
    state.root.join("wakeword")
}

fn wake_status(state: &Desktop) -> Value {
    let dir = wake_dir(state);
    let missing: Vec<&str> = ["melspectrogram.onnx", "embedding_model.onnx"]
        .into_iter()
        .filter(|f| !dir.join(f).is_file())
        .collect();
    let result = wake::check_manifest(&dir).and_then(|m| {
        if !missing.is_empty() {
            Err(format!("Не хватает файлов: {}", missing.join(", ")))
        } else if !dir.join(&m.model).is_file() {
            Err(format!("Нет файла модели {}", m.model))
        } else {
            Ok(m)
        }
    });
    match result {
        Ok(m) => {
            json!({"ready":true,"dir":dir,"model":m.model,"license":m.license,"source":m.source})
        }
        Err(message) => json!({"ready":false,"dir":dir,"message":message}),
    }
}

#[tauri::command]
fn voice_status(state: State<'_, Desktop>) -> Value {
    let dropped = state.live.lock().ok().and_then(|l| {
        l.as_ref()
            .map(|l| l.capture.dropped.load(Ordering::Relaxed))
    });
    json!({"wake":wake_status(&state),"live":dropped.is_some(),"dropped_frames":dropped.unwrap_or(0)})
}

#[tauri::command]
fn live_start(app: tauri::AppHandle, state: State<'_, Desktop>) -> Result<u64, String> {
    let settings = state.settings.lock().map_err(lock_error)?.voice.clone();
    if settings.mode == "ptt" {
        return Err("Выберите режим «Нейра» или «Слушать всегда» в настройках голоса".into());
    }
    if state.voice.lock().map_err(lock_error)?.is_none() {
        return Err("Нет голосового подключения".into());
    }
    if state.recording.lock().map_err(lock_error)?.is_some() {
        return Err("Сначала завершите запись".into());
    }
    {
        let live = state.live.lock().map_err(lock_error)?;
        if let Some(existing) = live.as_ref() {
            return Ok(existing.run);
        }
    }
    let mut detector = if settings.mode == "wake" {
        Some(
            wake::Detector::open(&wake_dir(&state))
                .map_err(|e| format!("Wake word недоступен: {e}"))?,
        )
    } else {
        None
    };
    let (frames_tx, frames) = std::sync::mpsc::sync_channel::<Vec<i16>>(50);
    let input_device = settings.input_device.trim();
    let dev_name = (!input_device.is_empty()).then_some(input_device);
    let capture = audio::LiveCapture::start(frames_tx, dev_name)?;
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let run_id = state.live_run.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut live = state.live.lock().map_err(lock_error)?;
        if let Some(existing) = live.as_ref() {
            drop(capture);
            return Ok(existing.run);
        }
        *live = Some(Live {
            capture,
            stop,
            run: run_id,
            worker: None,
        });
    }
    let handle = app.clone();
    let worker = std::thread::spawn(move || {
        let mut gate = voice::Gate::new(&settings);
        let mut trigger = voice::WakeTrigger::new(settings.wake_threshold);
        let mut request: Option<String> = None;
        let mut level = 0usize;
        let emit = |value: Value| {
            let _ = handle.emit("desktop-event", with_run(value, run_id));
        };
        emit(json!({"type":"live.started","mode":settings.mode}));
        while !stopped.load(Ordering::SeqCst) {
            let Ok(frame) = frames.recv_timeout(std::time::Duration::from_millis(200)) else {
                continue;
            };
            let state = handle.state::<Desktop>();
            level += 1;
            if level.is_multiple_of(5) {
                emit(json!({"type":"mic.level","db":voice::Vad::level_db(&frame)}));
            }
            let mut woke = false;
            if let Some(d) = detector.as_mut() {
                match d.push(&frame) {
                    Ok(scores) if gate.is_idle() => {
                        woke = scores.into_iter().any(|s| trigger.push(s))
                    }
                    Ok(_) => {}
                    Err(_) => {
                        emit(json!({"type":"error","code":"wake_failed"}));
                        break;
                    }
                }
            }
            let playing = state.player.playing.load(Ordering::SeqCst);
            for action in gate.push(&frame, woke, playing) {
                let sent = match action {
                    voice::Action::Wake => {
                        emit(json!({"type":"wake"}));
                        Ok(())
                    }
                    voice::Action::WakeExpired => {
                        emit(json!({"type":"live.idle"}));
                        Ok(())
                    }
                    voice::Action::Begin => {
                        let id = uuid::Uuid::new_v4().to_string();
                        // Barge-in: a new phrase replaces any running turn and its audio.
                        state.generation.fetch_add(1, Ordering::SeqCst);
                        if let Ok(mut s) = state.segments.lock() {
                            s.reset(None);
                        }
                        if let Ok(mut t) = state.current_turn.lock() {
                            *t = Some(id.clone());
                        }
                        request = Some(id.clone());
                        emit(json!({"type":"listening"}));
                        send(&state.voice, json!({"type":"listen.begin","request_id":id}))
                    }
                    voice::Action::Audio(bytes) => {
                        state.voice.lock().map_err(lock_error).and_then(|v| {
                            v.as_ref()
                                .ok_or_else(|| "Нет подключения".to_string())?
                                .send(Message::Binary(bytes.into()))
                                .map_err(|_| "Подключение закрыто".to_string())
                        })
                    }
                    voice::Action::Commit => {
                        emit(json!({"type":"transcribing"}));
                        send(
                            &state.voice,
                            json!({"type":"commit","mode":"live","request_id":request}),
                        )
                    }
                    voice::Action::Cancel => {
                        if let Ok(mut t) = state.current_turn.lock() {
                            if t.is_some() && *t == request {
                                *t = None;
                            }
                        }
                        emit(json!({"type":"live.idle"}));
                        send(
                            &state.voice,
                            json!({"type":"listen.cancel","request_id":request.take()}),
                        )
                    }
                };
                if sent.is_err() {
                    stopped.store(true, Ordering::SeqCst);
                }
            }
        }
        if gate.is_sending() {
            let state = handle.state::<Desktop>();
            let _ = send(
                &state.voice,
                json!({"type":"listen.cancel","request_id":request}),
            );
        }
        emit(json!({"type":"live.stopped"}));
        // The worker owns the microphone until it leaves. Stop joins; this path only drops it.
        if let Ok(mut slot) = handle.state::<Desktop>().live.lock() {
            if slot.as_ref().is_some_and(|live| live.run == run_id) {
                if let Some(live) = slot.take() {
                    live.stop.store(true, Ordering::SeqCst);
                    drop(live.capture);
                    drop(live.worker);
                }
            }
        }
    });
    if let Ok(mut slot) = state.live.lock() {
        if let Some(live) = slot.as_mut().filter(|live| live.run == run_id) {
            live.worker = Some(worker);
        } else {
            drop(worker);
        }
    } else {
        drop(worker);
    }
    Ok(run_id)
}

fn live_stop_inner(state: &Desktop) -> Result<(), String> {
    let taken = state.live.lock().map_err(lock_error)?.take();
    if let Some(live) = taken {
        release_live(live);
    }
    Ok(())
}

#[tauri::command]
fn live_stop(state: State<'_, Desktop>) -> Result<(), String> {
    live_stop_inner(&state)
}

fn receive_call(app: tauri::AppHandle, call: ToolCall) {
    let state = app.state::<Desktop>();
    if state.screen_locked.load(Ordering::SeqCst) {
        reply(
            &app,
            &call,
            if computer::is_tool(&call.tool) {
                computer::Error::PermissionDenied.response(false)
            } else {
                json!({"status":"denied","code":"session_locked"})
            },
            false,
        );
        return;
    }
    // Server calls are only ever checked against the connected profile's session, never the local one.
    let decision = (|| {
        if state.screen_locked.load(Ordering::SeqCst) {
            return Err("Сессия заблокирована".into());
        }
        let settings = state.settings.lock().map_err(lock_error)?;
        let id = state
            .active_profile
            .lock()
            .map_err(lock_error)?
            .clone()
            .ok_or("Нет сессии")?;
        let p = settings
            .profiles
            .iter()
            .find(|p| p.id == id)
            .ok_or("Нет профиля")?;
        let mut seen = state.seen.lock().map_err(lock_error)?;
        policy::validate(
            &call,
            &settings.permissions,
            &state.root,
            &settings.device_id,
            &p.session_id,
            &mut seen,
        )
    })();
    match decision {
        Ok(Decision::Safe) => execute_call(app.clone(), call, false),
        Ok(Decision::Confirm) => {
            if !queue_confirm(&app, call.clone()) {
                let result = if computer::is_tool(&call.tool) {
                    computer::Error::Timeout.response(false)
                } else {
                    json!({"status":"denied"})
                };
                reply(&app, &call, result, false);
            }
        }
        Err(message) => {
            let result = if computer::is_tool(&call.tool) {
                computer::Error::from_policy(&message).response(false)
            } else {
                json!({"status":"denied"})
            };
            reply(&app, &call, result, false);
        }
    }
}

/// Shows a one-time confirmation card (up to 30 s). Returns false when too many cards are open.
fn queue_confirm(app: &tauri::AppHandle, call: ToolCall) -> bool {
    let state = app.state::<Desktop>();
    let Ok(mut pending) = state.pending.lock() else {
        return false;
    };
    if pending.len() >= 4 {
        return false;
    }
    pending.insert(call.call_id.clone(), call.clone());
    drop(pending);
    // Window may be tray-hidden; surface the card (AR-4).
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    let preview = state
        .settings
        .lock()
        .map(|s| policy::preview(&call, &s.permissions, &state.root))
        .unwrap_or_default();
    let mut card = serde_json::to_value(&call).unwrap_or_default();
    card["preview"] = json!(preview);
    let _ = app.emit("host-confirm", card);
    let h = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        let st = h.state::<Desktop>();
        let expired = st
            .pending
            .lock()
            .ok()
            .and_then(|mut p| p.remove(&call.call_id));
        if let Some(c) = expired {
            let call_id = c.call_id.clone();
            reply(
                &h,
                &c,
                if computer::is_tool(&c.tool) {
                    computer::Error::Timeout.response(false)
                } else {
                    json!({"status":"denied","code":"confirmation_expired"})
                },
                false,
            );
            let _ = h.emit("host-confirm-closed", json!({"call_id": call_id}));
        }
    });
    true
}

fn is_local(call: &ToolCall) -> bool {
    call.session_id == commands::LOCAL_SESSION
}

fn reply(app: &tauri::AppHandle, call: &ToolCall, result: Value, confirmed: bool) {
    let state = app.state::<Desktop>();
    let days = state.settings.lock().map(|s| s.audit_days).unwrap_or(30);
    match state.audit_lock.lock() {
        Ok(_guard) => {
            if let Err(error) = audit::append(
                &state.root,
                &call.tool,
                result["status"].as_str().unwrap_or("error"),
                confirmed,
                days,
            ) {
                logs::log(
                    &state.root,
                    "warn",
                    &format!("audit append failed for tool {}: {error}", call.tool),
                );
            }
        }
        Err(_) => logs::log(
            &state.root,
            "warn",
            &format!(
                "audit append skipped for tool {}: audit lock poisoned",
                call.tool
            ),
        ),
    }
    if is_local(call) {
        // Quick commands report to their own runner, never to the server.
        let waiter = state
            .waiters
            .lock()
            .ok()
            .and_then(|mut w| w.remove(&call.call_id));
        if let Some(waiter) = waiter {
            let _ = waiter.send(result);
        }
    } else {
        let _ = send(
            &state.bridge,
            json!({"type":"client_tool_result","call_id":call.call_id,"result":result}),
        );
    }
    let _ = app.emit("host-activity", json!({"active":false}));
}
fn execute_call(app: tauri::AppHandle, call: ToolCall, confirmed: bool) {
    let cancel = {
        let state = app.state::<Desktop>();
        let value = match state.cancelled.lock() {
            Ok(c) => c.clone(),
            Err(_) => return,
        };
        value
    };
    let current_check = (|| {
        let state = app.state::<Desktop>();
        if state.screen_locked.load(Ordering::SeqCst) {
            return Err("Сессия заблокирована".into());
        }
        let settings = state.settings.lock().map_err(lock_error)?;
        let session = expected_session(&state, &settings, &call)?;
        policy::validate(
            &call,
            &settings.permissions,
            &state.root,
            &settings.device_id,
            &session,
            &mut HashMap::new(),
        )
    })();
    if current_check.is_err() || cancel.load(Ordering::SeqCst) {
        let result = if computer::is_tool(&call.tool) {
            if cancel.load(Ordering::SeqCst) {
                computer::Error::Cancelled.response(false)
            } else {
                computer::Error::from_policy(
                    current_check
                        .as_ref()
                        .err()
                        .map(String::as_str)
                        .unwrap_or_default(),
                )
                .response(false)
            }
        } else {
            json!({"status":"denied"})
        };
        reply(&app, &call, result, confirmed);
        return;
    }
    let (permissions, root) = {
        let state = app.state::<Desktop>();
        let permissions = match state.settings.lock() {
            Ok(s) => s.permissions.clone(),
            Err(_) => return,
        };
        (permissions, state.root.clone())
    };
    let _ = app.emit("host-activity", json!({"active":true,"tool":call.tool}));
    let powerful = POWERFUL.contains(&call.tool.as_str());
    if powerful {
        set_tray_activity(&app, true);
    }
    let action_cancel = if is_local(&call) {
        let flag = Arc::new(AtomicBool::new(false));
        let state = app.state::<Desktop>();
        if let Ok(mut flags) = state.local_cancels.lock() {
            flags.insert(call.call_id.clone(), flag.clone());
        }
        state.local_inflight.fetch_add(1, Ordering::SeqCst);
        flag
    } else {
        cancel
    };
    tauri::async_runtime::spawn(async move {
        let c = call.clone();
        let local = is_local(&call);
        let call_id = call.call_id.clone();
        let handle = app.clone();
        let result = tauri::async_runtime::spawn_blocking(move || match c.tool.as_str() {
            "client.screenshot" | "client.input" => with_own_windows_hidden(&handle, || {
                screen::with_backend(|backend| {
                    if c.tool == "client.screenshot" {
                        let window = c.arguments.get("window").and_then(Value::as_str);
                        screen::capture(backend, window, &c.session_id)
                    } else {
                        let args = c.arguments.as_object().ok_or("Неверные параметры")?;
                        screen::run(backend, args, &c.session_id, &action_cancel)
                    }
                })
            }),
            tool if computer::is_tool(tool) => with_own_windows_hidden(&handle, || {
                host::execute(&c, action_cancel, &permissions, &root)
            }),
            _ => host::execute(&c, action_cancel, &permissions, &root),
        })
        .await;
        if powerful {
            set_tray_activity(&app, false);
        }
        let value = match result {
            Ok(Ok(v)) => v,
            Ok(Err(_)) if computer::is_tool(&call.tool) => {
                computer::Error::ActionFailed.response(call.tool != "client.computer_snapshot")
            }
            Ok(Err(message)) => {
                json!({"status":"error","code":"local_action_failed","message":message})
            }
            Err(_) if computer::is_tool(&call.tool) => {
                computer::Error::ActionFailed.response(call.tool != "client.computer_snapshot")
            }
            Err(_) => json!({"status":"error","code":"local_action_failed"}),
        };
        reply(&app, &call, value, confirmed);
        if local {
            let state = app.state::<Desktop>();
            if let Ok(mut flags) = state.local_cancels.lock() {
                flags.remove(&call_id);
            }
            state.local_inflight.fetch_sub(1, Ordering::SeqCst);
        }
    });
}

/// Local quick-command calls were validated against the local session when queued; server calls against the profile.
fn expected_session(
    state: &Desktop,
    settings: &Settings,
    call: &ToolCall,
) -> Result<String, String> {
    if is_local(call) {
        return Ok(commands::LOCAL_SESSION.into());
    }
    let id = state
        .active_profile
        .lock()
        .map_err(lock_error)?
        .clone()
        .ok_or("Нет сессии")?;
    settings
        .profiles
        .iter()
        .find(|p| p.id == id)
        .map(|p| p.session_id.clone())
        .ok_or_else(|| "Нет профиля".into())
}

/// Contours 3–4: the tray shows that Neyra is controlling the PC while they run (§3b.9).
const POWERFUL: &[&str] = &[
    "client.shell_exec",
    "client.fs_write",
    "client.fs_mkdir",
    "client.fs_move",
    "client.screenshot",
    "client.input",
    "client.computer_snapshot",
    "client.computer_click",
    "client.computer_type",
    "client.computer_press",
];

const TRAY_ICON: &[u8] = include_bytes!("../icons/icon.png");
const TRAY_ICON_ACTIVE: &[u8] = include_bytes!("../icons/tray-active.png");

fn tray_icon(active: bool) -> Result<tauri::image::Image<'static>, String> {
    let bytes = if active { TRAY_ICON_ACTIVE } else { TRAY_ICON };
    let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    let mut reader = decoder.read_info().map_err(|_| "Неверный значок")?;
    let mut buffer = vec![0; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut buffer)
        .map_err(|_| "Неверный значок")?;
    if info.bit_depth != png::BitDepth::Eight || info.color_type != png::ColorType::Rgba {
        return Err("Значок трея должен быть PNG RGBA".into());
    }
    buffer.truncate(info.buffer_size());
    Ok(tauri::image::Image::new_owned(
        buffer,
        info.width,
        info.height,
    ))
}

fn set_tray_activity(app: &tauri::AppHandle, active: bool) {
    if let Some(tray) = app.tray_by_id("main") {
        if let Ok(icon) = tray_icon(active) {
            let _ = tray.set_icon(Some(icon));
        }
        let label = if active {
            "Нейра управляет ПК"
        } else {
            "Neyra"
        };
        let _ = tray.set_tooltip(Some(if active {
            "Нейра управляет ПК — Stop в меню"
        } else {
            "Neyra"
        }));
        // Title sits next to the icon. The menu row stays visible when the window is hidden.
        let _ = tray.set_title(Some(if active { label } else { "" }));
        let status = tauri::menu::MenuItem::with_id(app, "activity", label, false, None::<&str>);
        let open = tauri::menu::MenuItem::with_id(app, "open", "Открыть Neyra", true, None::<&str>);
        let stop = tauri::menu::MenuItem::with_id(app, "stop", "Stop", true, None::<&str>);
        let quit = tauri::menu::MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>);
        if let (Ok(status), Ok(open), Ok(stop), Ok(quit)) = (status, open, stop, quit) {
            if let Ok(menu) = tauri::menu::Menu::with_items(app, &[&status, &open, &stop, &quit]) {
                let _ = tray.set_menu(Some(menu));
            }
        }
    }
}

/// Own windows are hidden while the screen is captured or driven, so the model neither
/// sees nor clicks Neyra itself; they come back afterwards, even on error.
fn with_own_windows_hidden<R>(
    app: &tauri::AppHandle,
    action: impl FnOnce() -> Result<R, String>,
) -> Result<R, String> {
    let hidden: Vec<_> = app
        .webview_windows()
        .into_values()
        .filter(|w| w.is_visible().unwrap_or(false))
        .collect();
    for w in &hidden {
        let _ = w.hide();
    }
    if !hidden.is_empty() {
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    let result = action();
    for w in &hidden {
        let _ = w.show();
    }
    result
}
#[tauri::command]
fn approve(
    app: tauri::AppHandle,
    state: State<'_, Desktop>,
    call_id: String,
    allow: bool,
) -> Result<(), String> {
    let call = state
        .pending
        .lock()
        .map_err(lock_error)?
        .remove(&call_id)
        .ok_or("Подтверждение устарело")?;
    if !allow {
        let result = if computer::is_tool(&call.tool) {
            computer::Error::PermissionDenied.response(false)
        } else {
            json!({"status":"denied"})
        };
        reply(&app, &call, result, false);
        return Ok(());
    }
    if call.tool == command_runner::CONFIRM_TOOL && is_local(&call) {
        // Command-level consent only; every action is still checked by the PC policy on its own.
        reply(&app, &call, json!({"status":"ok"}), true);
        return Ok(());
    }
    let settings = state.settings.lock().map_err(lock_error)?.clone();
    let session = expected_session(&state, &settings, &call)?;
    let validation = policy::validate(
        &call,
        &settings.permissions,
        &state.root,
        &settings.device_id,
        &session,
        &mut HashMap::new(),
    );
    if let Err(message) = validation {
        if computer::is_tool(&call.tool) {
            reply(
                &app,
                &call,
                computer::Error::from_policy(&message).response(false),
                true,
            );
            return Ok(());
        }
        return Err(message);
    }
    execute_call(app, call, true);
    Ok(())
}
#[tauri::command]
fn chat_epoch(state: State<'_, Desktop>) -> Result<u64, String> {
    state.chat_dispatch.snapshot()
}
#[tauri::command]
fn chat(
    app: tauri::AppHandle,
    state: State<'_, Desktop>,
    text: String,
    target_device_id: Option<String>,
    request_id: chat_dispatch::ChatRequestId,
    dispatch_epoch: u64,
) -> Result<Value, String> {
    if text.trim().is_empty() || text.len() > 6000 {
        return Err("Сообщение должно содержать 1–6000 символов".into());
    }
    state.chat_dispatch.dispatch(dispatch_epoch, || {
        // An exact quick-command phrase runs locally without a model turn; anything else goes to the server.
        if let Some(handled) = command_runner::try_phrase(&app, &state, &text)? {
            return Ok(handled);
        }
        if state.recording.lock().map_err(lock_error)?.is_some() {
            return Err("Сначала завершите запись".into());
        }
        // The WebView may receive WSS events before this IPC call resolves.
        // Accept its preallocated ID so it can correlate those events immediately.
        let request_id = start_turn_with_id(&state, request_id.0)?;
        let result = send(
            &state.bridge,
            json!({"type":"chat","text":text,"target_device_id":target_device_id,"request_id":request_id}),
        );
        if result.is_err() {
            *state.current_turn.lock().map_err(lock_error)? = None;
        }
        result.map(|_| json!({"handled":false}))
    })
}
#[tauri::command]
fn disconnect_device(state: State<'_, Desktop>, device_id: String) -> Result<(), String> {
    uuid::Uuid::parse_str(&device_id).map_err(|_| "Неверный ID устройства")?;
    send(
        &state.bridge,
        json!({"type":"disconnect_device","target_device_id":device_id}),
    )
}
#[tauri::command]
fn bridge_message(state: State<'_, Desktop>, kind: String) -> Result<(), String> {
    if !matches!(kind.as_str(), "devices" | "history") {
        return Err("Неверное действие".into());
    }
    send(&state.bridge, json!({"type":kind}))
}
enum TurnStartError {
    Busy,
    Internal(String),
}
impl From<TurnStartError> for String {
    fn from(value: TurnStartError) -> Self {
        match value {
            TurnStartError::Busy => "Сначала дождитесь ответа или нажмите Stop".into(),
            TurnStartError::Internal(message) => message,
        }
    }
}
fn start_turn_with_id(state: &Desktop, id: String) -> Result<String, String> {
    reserve_turn_with_id(&state.current_turn, id).map_err(String::from)
}
fn start_turn_typed(state: &Desktop) -> Result<String, TurnStartError> {
    reserve_turn_typed(&state.current_turn)
}
#[cfg(test)]
fn reserve_turn(current: &Mutex<Option<String>>) -> Result<String, String> {
    reserve_turn_typed(current).map_err(String::from)
}
fn reserve_turn_typed(current: &Mutex<Option<String>>) -> Result<String, TurnStartError> {
    reserve_turn_with_id(current, uuid::Uuid::new_v4().to_string())
}
fn reserve_turn_with_id(
    current: &Mutex<Option<String>>,
    id: String,
) -> Result<String, TurnStartError> {
    let mut current = current
        .lock()
        .map_err(|e| TurnStartError::Internal(lock_error(e)))?;
    if current.is_some() {
        return Err(TurnStartError::Busy);
    }
    *current = Some(id.clone());
    Ok(id)
}
fn stop_inner(state: &Desktop) -> Result<(), String> {
    state.chat_dispatch.cancel(|| stop_inner_locked(state))
}
fn stop_inner_locked(state: &Desktop) -> Result<(), String> {
    // Stop also turns the live microphone off: nothing keeps listening after Stop.
    live_stop_inner(state)?;
    state.generation.fetch_add(1, Ordering::SeqCst);
    state.segments.lock().map_err(lock_error)?.reset(None);
    *state.current_turn.lock().map_err(lock_error)? = None;
    let mut cancel = state.cancelled.lock().map_err(lock_error)?;
    cancel.store(true, Ordering::SeqCst);
    *cancel = Arc::new(AtomicBool::new(false));
    computer::reset();
    screen::forget_all();
    state.pending.lock().map_err(lock_error)?.clear();
    if let Ok(flags) = state.local_cancels.lock() {
        for flag in flags.values() {
            flag.store(true, Ordering::SeqCst);
        }
    }
    // Dropping the senders wakes any running quick command, which then reports "stopped".
    state.waiters.lock().map_err(lock_error)?.clear();
    if let Some(recording) = state.recording.lock().map_err(lock_error)?.take() {
        std::thread::spawn(move || {
            let _ = recording.finish();
        });
    }
    let _ = send(&state.bridge, json!({"type":"stop"}));
    let _ = send(&state.voice, json!({"type":"stop"}));
    Ok(())
}
fn disconnect_inner(state: &Desktop) -> Result<(), String> {
    let _guard = state.transport.lock().map_err(lock_error)?;
    disconnect_locked(state)
}
fn disconnect_locked(state: &Desktop) -> Result<(), String> {
    stop_inner(state)?;
    state.epoch.fetch_add(1, Ordering::SeqCst);
    *state.bridge.lock().map_err(lock_error)? = None;
    *state.voice.lock().map_err(lock_error)? = None;
    *state.active_profile.lock().map_err(lock_error)? = None;
    Ok(())
}
#[tauri::command]
fn stop(app: tauri::AppHandle, state: State<'_, Desktop>) -> Result<(), String> {
    stop_inner(&state)?;
    app.emit("desktop-event", json!({"type":"cancelled","scope":"all"}))
        .map_err(|_| "Ошибка окна".into())
}
#[tauri::command]
fn disconnect(state: State<'_, Desktop>) -> Result<(), String> {
    disconnect_inner(&state)
}
#[tauri::command]
async fn record_start(
    app: tauri::AppHandle,
    state: State<'_, Desktop>,
) -> Result<(), CaptureError> {
    if state
        .current_turn
        .lock()
        .map_err(|e| CaptureError::internal(lock_error(e)))?
        .is_some()
    {
        return Err(CaptureError::TurnBusy);
    }
    if state
        .voice
        .lock()
        .map_err(|e| CaptureError::internal(lock_error(e)))?
        .is_none()
    {
        return Err(CaptureError::VoiceOffline);
    }
    if state
        .live
        .lock()
        .map_err(|e| CaptureError::internal(lock_error(e)))?
        .is_some()
    {
        return Err(CaptureError::LiveActive);
    }
    state.generation.fetch_add(1, Ordering::SeqCst);
    let mut recording = state
        .recording
        .lock()
        .map_err(|e| CaptureError::internal(lock_error(e)))?;
    if recording.is_some() {
        return Err(CaptureError::AlreadyRecording);
    }
    let input_device = {
        let s = state
            .settings
            .lock()
            .map_err(|e| CaptureError::internal(lock_error(e)))?;
        s.voice.input_device.clone()
    };
    let dev_name = (!input_device.trim().is_empty()).then_some(input_device.as_str());
    let started = audio::Recording::start(dev_name).map_err(CaptureError::Device)?;
    let level = started.level.clone();
    let meter_stop = started.meter_stop.clone();
    *recording = Some(started);
    drop(recording);
    std::thread::spawn(move || {
        while !meter_stop.load(Ordering::Relaxed) {
            let db = level.load(Ordering::Relaxed) as f32 / 10.0;
            let _ = app.emit("desktop-event", json!({"type":"mic.level","db":db}));
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    });
    Ok(())
}
/// Capture failures with a stable code for the UI, independent of the Russian text.
#[derive(Debug, PartialEq, Eq)]
enum CaptureError {
    TurnBusy,
    VoiceOffline,
    AlreadyRecording,
    LiveActive,
    NoCapture,
    EmptyCapture,
    Device(String),
    Internal(String),
}

impl CaptureError {
    fn internal(message: impl Into<String>) -> Self {
        Self::Internal(message.into())
    }

    fn code(&self) -> &'static str {
        match self {
            Self::TurnBusy => "turn_busy",
            Self::VoiceOffline => "voice_unavailable",
            Self::AlreadyRecording => "already_recording",
            Self::LiveActive => "live_active",
            Self::NoCapture => "no_capture",
            Self::EmptyCapture => "empty_capture",
            Self::Device(_) => "microphone_unavailable",
            Self::Internal(_) => "internal_error",
        }
    }
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TurnBusy => write!(f, "Дождитесь ответа или нажмите Stop"),
            Self::VoiceOffline => write!(f, "Нет голосового подключения"),
            Self::AlreadyRecording => write!(f, "Запись уже идёт"),
            Self::LiveActive => write!(f, "Сначала остановите разговор голосом"),
            Self::NoCapture => write!(f, "Нет записи"),
            Self::EmptyCapture => write!(f, "Запись пустая"),
            Self::Device(message) | Self::Internal(message) => write!(f, "{message}"),
        }
    }
}

impl From<String> for CaptureError {
    fn from(message: String) -> Self {
        Self::Device(message)
    }
}

impl serde::Serialize for CaptureError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

// The same capture/commit boundary is exercised without opening an audio device.
async fn finish_ptt(
    current_turn: &Mutex<Option<String>>,
    request_id: &str,
    finish: impl std::future::Future<Output = Result<Vec<u8>, String>>,
    send_pcm: impl FnOnce(Vec<u8>) -> Result<(), CaptureError>,
) -> Result<(), CaptureError> {
    let result = async {
        let pcm = finish.await.map_err(CaptureError::Device)?;
        if pcm.is_empty() {
            return Err(CaptureError::EmptyCapture);
        }
        send_pcm(pcm)
    }
    .await;
    if result.is_err() {
        if let Ok(mut current) = current_turn.lock() {
            // A delayed old capture must not clear a newer turn after Stop.
            if current.as_deref() == Some(request_id) {
                *current = None;
            }
        }
    }
    result
}

#[tauri::command]
async fn record_stop(app: tauri::AppHandle, state: State<'_, Desktop>) -> Result<(), CaptureError> {
    let recording = state
        .recording
        .lock()
        .map_err(|e| CaptureError::internal(lock_error(e)))?
        .take()
        .ok_or(CaptureError::NoCapture)?;
    let request_id = match start_turn_typed(&state) {
        Ok(id) => id,
        Err(error) => {
            // Dropping a live capture without finish() keeps the meter stream alive.
            let _ = tauri::async_runtime::spawn_blocking(move || recording.finish()).await;
            return Err(match error {
                TurnStartError::Busy => CaptureError::TurnBusy,
                TurnStartError::Internal(message) => CaptureError::internal(message),
            });
        }
    };
    finish_ptt(
        &state.current_turn,
        &request_id,
        async {
            tauri::async_runtime::spawn_blocking(move || recording.finish())
                .await
                .map_err(|_| "Ошибка записи".to_string())?
        },
        |pcm| {
            // Never announce a clip before there is a voice socket to carry it.
            let tx = state
                .voice
                .lock()
                .map_err(|e| CaptureError::internal(lock_error(e)))?
                .clone()
                .ok_or(CaptureError::VoiceOffline)?;
            let duration_ms = (pcm.len() as u64).saturating_mul(1000) / 32_000;
            let clip = base64::engine::general_purpose::STANDARD.encode(audio::wav_s16le_16k(&pcm));
            let _ = app.emit(
                "desktop-event",
                json!({"type":"voice.clip","audio":clip,"duration_ms":duration_ms}),
            );
            for chunk in pcm.chunks(32000) {
                tx.send(Message::Binary(chunk.to_vec().into()))
                    .map_err(|_| CaptureError::VoiceOffline)?;
            }
            tx.send(Message::Text(
                json!({"type":"commit","request_id":request_id})
                    .to_string()
                    .into(),
            ))
            .map_err(|_| CaptureError::VoiceOffline)?;
            Ok(())
        },
    )
    .await
}
#[tauri::command]
async fn record_cancel(state: State<'_, Desktop>) -> Result<(), String> {
    let recording = state.recording.lock().map_err(lock_error)?.take();
    if let Some(recording) = recording {
        tauri::async_runtime::spawn_blocking(move || {
            let _ = recording.finish();
        });
    }
    Ok(())
}

#[tauri::command]
fn audio_devices() -> audio::AudioDevices {
    audio::list_audio_devices()
}

#[tauri::command]
fn speak_text(state: State<'_, Desktop>, text: String) -> Result<(), String> {
    let spoken: String = text.trim().chars().take(300).collect();
    if spoken.is_empty() {
        return Err("Нечего озвучивать".into());
    }
    send(&state.voice, json!({"type":"speak","text":spoken}))
}
#[tauri::command]
fn audit_log(state: State<'_, Desktop>) -> Result<Vec<Value>, String> {
    let _guard = state.audit_lock.lock().map_err(lock_error)?;
    let days = state.settings.lock().map_err(lock_error)?.audit_days;
    audit::prune(&state.root, days)?;
    audit::recent(&state.root, days)
}
#[tauri::command]
async fn applications() -> Vec<String> {
    host::discover_apps()
}
#[tauri::command]
fn load_chats(state: State<'_, Desktop>) -> Result<storage::ChatLoad, String> {
    let loaded = storage::load_chats(&state.root)?;
    if let Some(recovery) = &loaded.recovery {
        state
            .recoveries
            .lock()
            .map_err(lock_error)?
            .push(recovery.clone());
    }
    Ok(loaded)
}
#[tauri::command]
fn save_chats(state: State<'_, Desktop>, threads: Vec<storage::SavedChat>) -> Result<(), String> {
    storage::save_chats(&state.root, &threads)
}

#[tauri::command]
fn perf_mark(
    window: tauri::WebviewWindow,
    state: State<'_, perf::Perf>,
    stage: perf::FrontendStage,
) {
    if window.label() == "main" {
        state.mark(stage.into());
    }
}

pub fn run() {
    let startup = perf::Startup::from_env();
    #[cfg(target_os = "linux")]
    apply_graphics();
    let builder = tauri::Builder::default();
    let builder = if startup.enabled() {
        builder.append_invoke_initialization_script("window.__NEYRA_PERF__ = true;")
    } else {
        builder
    };
    let result = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let setup_elapsed = startup.setup_elapsed();
            let root = storage::data_root().map_err(std::io::Error::other)?;
            app.manage(startup.attach(&root, setup_elapsed));
            logs::install_crash_hook(root.clone());
            let (settings, recoveries) =
                storage::initialize(&root).map_err(std::io::Error::other)?;
            for r in &recoveries {
                logs::log(
                    &root,
                    "warn",
                    &format!(
                        "recovered {} reason={} restored={}",
                        r.file, r.reason, r.restored
                    ),
                );
            }
            if let Err(error) =
                audit::start_pruning(app.handle().clone(), root.clone(), settings.audit_days)
            {
                logs::log(
                    &root,
                    "warn",
                    &format!("could not start audit pruning: {error}"),
                );
            }
            let generation = Arc::new(AtomicU64::new(0));
            let output_device = Arc::new(Mutex::new(settings.voice.output_device.clone()));
            let events = app.handle().clone();
            let gen = generation.clone();
            let out_dev = output_device.clone();
            let player = audio::Player::start(gen, out_dev, move |event| {
                let state = events.state::<Desktop>();
                match event {
                    audio::PlayerEvent::Started => {
                        let _ = events.emit("desktop-event", json!({"type":"speaking"}));
                    }
                    audio::PlayerEvent::Played(seq) => {
                        let request = state.segments.lock().ok().and_then(|s| s.request());
                        let _ = send(
                            &state.voice,
                            json!({"type":"audio.ack","request_id":request,"seq":seq}),
                        );
                    }
                    audio::PlayerEvent::Finished => {
                        let _ = events.emit("desktop-event", json!({"type":"audio.finished"}));
                    }
                    audio::PlayerEvent::Error(code) => {
                        let _ = events.emit("desktop-event", json!({"type":"error","code":code}));
                    }
                }
            });
            app.manage(Desktop {
                root,
                settings: Mutex::new(settings),
                bridge: Mutex::new(None),
                voice: Mutex::new(None),
                active_profile: Mutex::new(None),
                seen: Mutex::new(HashMap::new()),
                pending: Mutex::new(HashMap::new()),
                cancelled: Mutex::new(Arc::new(AtomicBool::new(false))),
                generation,
                recording: Mutex::new(None),
                epoch: AtomicU64::new(0),
                transport: Mutex::new(()),
                audit_lock: Mutex::new(()),
                shortcuts: AtomicBool::new(false),
                screen_locked: AtomicBool::new(true),
                current_turn: Mutex::new(None),
                chat_dispatch: chat_dispatch::ChatDispatch::default(),
                commands: Mutex::new(commands::Store::default()),
                waiters: Mutex::new(HashMap::new()),
                drafts: Mutex::new(HashMap::new()),
                hotkeys: Mutex::new(HashMap::new()),
                hotkey_backend: AtomicBool::new(false),
                running: Mutex::new(None),
                pending_import: Mutex::new(None),
                recoveries: Mutex::new(recoveries),
                relocated: AtomicBool::new(false),
                pending_data_move: Mutex::new(None),
                local_inflight: AtomicUsize::new(0),
                local_cancels: Mutex::new(HashMap::new()),
                output_device,
                player,
                segments: Mutex::new(voice::Segments::default()),
                live: Mutex::new(None),
                live_run: AtomicU64::new(0),
            });
            monitor_session(app.handle().clone());
            setup_shortcuts(app.handle());
            command_runner::start_watcher(app.handle().clone());
            screen::start_probe();
            let activity =
                tauri::menu::MenuItem::with_id(app, "activity", "Neyra", false, None::<&str>)?;
            let open =
                tauri::menu::MenuItem::with_id(app, "open", "Открыть Neyra", true, None::<&str>)?;
            let stop = tauri::menu::MenuItem::with_id(app, "stop", "Stop", true, None::<&str>)?;
            let quit = tauri::menu::MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&activity, &open, &stop, &quit])?;
            tauri::tray::TrayIconBuilder::with_id("main")
                .icon(
                    app.default_window_icon()
                        .cloned()
                        .ok_or("Missing app icon")?,
                )
                .menu(&menu)
                .tooltip("Neyra")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "stop" => {
                        let state = app.state::<Desktop>();
                        let _ = stop_inner(&state);
                        let _ =
                            app.emit("desktop-event", json!({"type":"cancelled","scope":"all"}));
                    }
                    "quit" => {
                        let state = app.state::<Desktop>();
                        let _ = disconnect_inner(&state);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            store_token,
            api,
            set_module,
            connect,
            disconnect,
            chat_epoch,
            chat,
            bridge_message,
            disconnect_device,
            approve,
            stop,
            record_start,
            record_stop,
            record_cancel,
            speak_text,
            host::open_http_url,
            audit_log,
            applications,
            load_chats,
            save_chats,
            perf_mark,
            command_runner::commands_list,
            command_runner::command_save,
            command_runner::command_save_yaml,
            command_runner::command_get_yaml,
            command_runner::command_delete,
            command_runner::command_set_enabled,
            command_runner::command_dry_run,
            command_runner::command_run,
            command_runner::command_run_phrase,
            command_runner::draft_confirm,
            command_runner::draft_reject,
            command_runner::config_export,
            command_runner::import_pick,
            command_runner::import_apply,
            command_runner::import_cancel,
            command_runner::choose_data_root,
            command_runner::confirm_data_root,
            voice_status,
            audio_devices,
            live_start,
            live_stop,
            character::character_state,
            character::character_save,
            character::character_overlay,
            character::character_model_info,
            character::character_model_load,
            updater::update_state,
            updater::update_save,
            updater::update_check,
            updater::update_install,
            updater::update_restart
        ])
        .run(tauri::generate_context!());
    if result.is_err() {
        eprintln!("Neyra: не удалось запустить приложение; проверьте системный WebView и доступ к папке данных");
    }
}

#[cfg(target_os = "linux")]
fn apply_graphics() {
    // Called before Tauri/GTK starts threads. Only explicit recovery modes alter graphics.
    let mode = storage::data_root()
        .ok()
        .map(|root| storage::graphics_mode(&root))
        .unwrap_or_else(|| "auto".into());
    if mode == "auto" {
        return;
    }
    for (key, original) in [
        ("GDK_BACKEND", "NEYRA_ORIGINAL_GDK_BACKEND"),
        ("WEBKIT_DISABLE_DMABUF_RENDERER", "NEYRA_ORIGINAL_DMABUF"),
        ("__NV_DISABLE_EXPLICIT_SYNC", "NEYRA_ORIGINAL_EXPLICIT_SYNC"),
    ] {
        if let Some(value) = std::env::var_os(key) {
            std::env::set_var(original, value);
        } else {
            std::env::remove_var(original);
        }
    }
    std::env::set_var("NEYRA_GRAPHICS_APPLIED", "1");
    match mode.as_str() {
        "wayland" => std::env::set_var("GDK_BACKEND", "wayland"),
        "wayland-nvidia" => {
            std::env::set_var("GDK_BACKEND", "wayland");
            std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
        }
        "x11" => std::env::set_var("GDK_BACKEND", "x11"),
        "compatibility" => {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
        _ => {}
    }
}

fn setup_shortcuts(app: &tauri::AppHandle) {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, ShortcutState};
    if !cfg!(windows) && std::env::var("XDG_SESSION_TYPE").unwrap_or_default() == "wayland" {
        return;
    }
    let plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state == ShortcutState::Pressed {
                if let Some(name) = command_runner::hotkey_command(app, shortcut.id()) {
                    command_runner::run_by_name(app.clone(), name, "hotkey");
                    return;
                }
            }
            if event.state == ShortcutState::Released
                && command_runner::hotkey_command(app, shortcut.id()).is_some()
            {
                return;
            }
            if shortcut.key == Code::Escape && event.state == ShortcutState::Pressed {
                let state = app.state::<Desktop>();
                let _ = stop_inner(&state);
                let _ = app.emit("desktop-event", json!({"type":"cancelled","scope":"all"}));
            } else if shortcut.key == Code::Space {
                let handle = app.clone();
                let pressed = event.state == ShortcutState::Pressed;
                tauri::async_runtime::spawn(async move {
                    let state = handle.state::<Desktop>();
                    let result = if pressed {
                        record_start(handle.clone(), state).await
                    } else {
                        record_stop(handle.clone(), state).await
                    };
                    match result {
                        Ok(()) => {
                            let _ = handle.emit(
                                "desktop-event",
                                json!({"type":if pressed{"recording"}else{"transcribing"}}),
                            );
                        }
                        Err(error) => {
                            let _ = handle.emit(
                                "desktop-event",
                                json!({"type":"capture.failed","code":error.code(),"stage":if pressed{"start"}else{"stop"}}),
                            );
                        }
                    }
                });
            }
        })
        .build();
    if app.plugin(plugin).is_err() {
        return;
    }
    app.state::<Desktop>()
        .hotkey_backend
        .store(true, Ordering::SeqCst);
    let stop = app.global_shortcut().register("Ctrl+Alt+Escape");
    let ptt = app.global_shortcut().register("Ctrl+Alt+Space");
    app.state::<Desktop>()
        .shortcuts
        .store(stop.is_ok() && ptt.is_ok(), Ordering::SeqCst);
}

fn monitor_session(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        let unlocked = host::session_unlocked();
        let state = app.state::<Desktop>();
        let old = state.screen_locked.swap(!unlocked, Ordering::SeqCst);
        if old == unlocked {
            if !unlocked {
                let _ = stop_inner(&state);
                let _ = app.emit("desktop-event", json!({"type":"cancelled","scope":"all"}));
            }
            let id = state.active_profile.lock().ok().and_then(|s| s.clone());
            if let Some(id) = id {
                if let Ok(p) = profile(&state, &id) {
                    if let Ok(manifest) = manifest(&state, &p) {
                        let _ = send(
                            &state.bridge,
                            json!({"type":"capabilities","manifest":manifest}),
                        );
                    }
                }
            }
            let _ = app.emit(
                "desktop-event",
                json!({"type":"pc_access","available":unlocked}),
            );
        }
        std::thread::sleep(std::time::Duration::from_secs(2));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_errors_have_stable_codes() {
        let cases = [
            (CaptureError::TurnBusy, "turn_busy"),
            (CaptureError::VoiceOffline, "voice_unavailable"),
            (CaptureError::AlreadyRecording, "already_recording"),
            (CaptureError::LiveActive, "live_active"),
            (CaptureError::NoCapture, "no_capture"),
            (CaptureError::EmptyCapture, "empty_capture"),
            (
                CaptureError::Device("device broke".into()),
                "microphone_unavailable",
            ),
            (
                CaptureError::Internal("Внутренняя ошибка состояния".into()),
                "internal_error",
            ),
        ];
        for (error, code) in cases {
            assert_eq!(error.code(), code);
            assert!(!error.to_string().is_empty());
        }
        assert_eq!(
            CaptureError::Device("device broke".into()).to_string(),
            "device broke"
        );
        assert_eq!(
            serde_json::to_string(&CaptureError::TurnBusy).unwrap(),
            "\"Дождитесь ответа или нажмите Stop\""
        );
    }

    #[test]
    fn poisoned_turn_lock_reports_internal_error_not_microphone() {
        let current = std::sync::Arc::new(Mutex::new(None));
        let poisoned = current.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poisoned.lock().unwrap();
            panic!("poison the turn lock on purpose");
        })
        .join();
        let error = match reserve_turn_typed(&current) {
            Ok(_) => panic!("poisoned lock must fail"),
            Err(error) => error,
        };
        let capture = match error {
            TurnStartError::Busy => panic!("a poisoned lock is not a busy turn"),
            TurnStartError::Internal(message) => CaptureError::internal(message),
        };
        assert_eq!(capture.code(), "internal_error");
        assert_ne!(capture.code(), "microphone_unavailable");
    }

    #[tokio::test]
    async fn ptt_empty_capture_never_commits_and_releases_turn_for_retry() {
        let current = Mutex::new(None);
        let id = reserve_turn(&current).unwrap();
        let error = finish_ptt(&current, &id, std::future::ready(Ok(vec![])), |_| {
            panic!("empty PCM must not reach the clip/commit boundary")
        })
        .await
        .unwrap_err();
        assert_eq!(error, CaptureError::EmptyCapture);
        assert!(current.lock().unwrap().is_none());
        assert!(reserve_turn(&current).is_ok());
    }

    #[tokio::test]
    async fn ptt_capture_failure_releases_turn_without_commit() {
        let current = Mutex::new(None);
        let id = reserve_turn(&current).unwrap();
        let error = finish_ptt(
            &current,
            &id,
            std::future::ready(Err("capture failed".into())),
            |_| panic!("failed capture must not commit"),
        )
        .await
        .unwrap_err();
        assert_eq!(error, CaptureError::Device("capture failed".into()));
        assert!(reserve_turn(&current).is_ok());
    }

    #[tokio::test]
    async fn ptt_send_failure_releases_turn_for_retry() {
        let current = Mutex::new(None);
        let id = reserve_turn(&current).unwrap();
        let error = finish_ptt(&current, &id, std::future::ready(Ok(vec![0, 1])), |pcm| {
            assert_eq!(pcm, vec![0, 1]);
            Err(CaptureError::VoiceOffline)
        })
        .await
        .unwrap_err();
        assert_eq!(error, CaptureError::VoiceOffline);
        assert_eq!(error.code(), "voice_unavailable");
        assert!(reserve_turn(&current).is_ok());
    }

    #[tokio::test]
    async fn ptt_success_keeps_turn_until_server_terminal() {
        let current = Mutex::new(None);
        let id = reserve_turn(&current).unwrap();
        let mut sent = false;
        finish_ptt(&current, &id, std::future::ready(Ok(vec![0, 1])), |pcm| {
            assert_eq!(pcm, vec![0, 1]);
            sent = true;
            Ok(())
        })
        .await
        .unwrap();
        assert!(sent);
        assert_eq!(current.lock().unwrap().as_deref(), Some(id.as_str()));
        assert!(reserve_turn(&current).is_err());
    }

    #[tokio::test]
    async fn ptt_late_failure_does_not_clear_new_turn() {
        let current = Mutex::new(None);
        let id = reserve_turn(&current).unwrap();
        let finish = async {
            *current.lock().unwrap() = None;
            let replacement = reserve_turn(&current).unwrap();
            assert_ne!(replacement, id);
            Ok(vec![])
        };
        assert!(finish_ptt(&current, &id, finish, |_| panic!("empty PCM"))
            .await
            .is_err());
        assert!(current.lock().unwrap().is_some());
        assert!(reserve_turn(&current).is_err());
    }

    fn test_token() -> String {
        let mut token = ["fleet", "test", "49"].join("-");
        token.push('+');
        token.push('/');
        token.push('=');
        token
    }

    fn local_profile(address: std::net::SocketAddr) -> Profile {
        Profile {
            id: "transport-test".into(),
            name: "local".into(),
            url: format!("http://{address}"),
            session_id: "test".into(),
        }
    }

    #[tokio::test]
    async fn invalid_connection_settings_return_config_errors() {
        let mut profile = local_profile("127.0.0.1:1".parse().unwrap());
        for (address, expected) in [
            ("invalid", "CONFIG_ERROR: Неверный адрес сервера"),
            ("ftp://localhost", "CONFIG_ERROR: Неверный адрес сервера"),
            (
                "http://example.com",
                "CONFIG_ERROR: Удалённый сервер требует HTTPS",
            ),
        ] {
            profile.url = address.into();
            let error =
                connect_sockets(&profile, &test_token(), &json!({}), Duration::from_secs(1))
                    .await
                    .unwrap_err();
            assert_eq!(error, expected);
        }
        profile.url = "http://127.0.0.1:1".into();
        let error = connect_sockets(&profile, "\n", &json!({}), Duration::from_secs(1))
            .await
            .unwrap_err();
        assert_eq!(error, "CONFIG_ERROR: Неверный токен");
    }

    #[tokio::test]
    async fn real_handshakes_refused_repeatedly() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let profile = local_profile(listener.local_addr().unwrap());
        drop(listener);
        for _ in 0..3 {
            let error =
                connect_sockets(&profile, &test_token(), &json!({}), Duration::from_secs(5))
                    .await
                    .unwrap_err();
            assert!(error.contains("отклонено"), "{error}");
        }
    }

    #[tokio::test]
    async fn real_second_handshake_refusal_closes_first_socket() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let profile = local_profile(listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            // Refuse subsequent TCP connections while the first WebSocket remains open.
            drop(listener);
            let mut first = tokio_tungstenite::accept_async(stream).await.unwrap();
            assert!(first.next().await.unwrap().unwrap().is_text());
            tokio::time::timeout(Duration::from_secs(7), first.next())
                .await
                .expect("failed replacement must release its first socket")
        });
        for _ in 0..3 {
            assert!(
                connect_sockets(&profile, &test_token(), &json!({}), Duration::from_secs(5))
                    .await
                    .is_err()
            );
        }
        assert!(matches!(server.await.unwrap(), Some(Ok(Message::Close(_)))));
    }

    #[tokio::test]
    async fn real_handshakes_timeout_and_http503_at_either_stage() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for stage in 0..2 {
            for timeout in [false, true] {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let profile = local_profile(listener.local_addr().unwrap());
                let server = tokio::spawn(async move {
                    let first = if stage == 1 {
                        let (tcp, _) = listener.accept().await.unwrap();
                        let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
                        assert!(socket.next().await.unwrap().unwrap().is_text());
                        Some(socket)
                    } else {
                        None
                    };
                    let (mut tcp, _) = listener.accept().await.unwrap();
                    let mut request = [0; 4096];
                    assert!(tcp.read(&mut request).await.unwrap() > 0);
                    if timeout {
                        std::future::pending::<()>().await;
                    } else {
                        tcp.write_all(
                            b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n",
                        )
                        .await
                        .unwrap();
                    }
                    drop(first);
                });
                let error = connect_sockets(
                    &profile,
                    &test_token(),
                    &json!({"type":"hello"}),
                    Duration::from_millis(100),
                )
                .await
                .unwrap_err();
                assert!(
                    error.contains(if timeout {
                        "не ответил"
                    } else {
                        "отклонено"
                    }),
                    "{error}"
                );
                server.abort();
            }
        }
    }

    #[tokio::test]
    async fn failed_replacements_preserve_established_sockets() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let profile = local_profile(listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut peers = Vec::new();
            for _ in 0..2 {
                let (tcp, _) = listener.accept().await.unwrap();
                let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
                ws.next().await.unwrap().unwrap();
                peers.push(tokio::spawn(async move {
                    while let Some(Ok(message)) = ws.next().await {
                        if message.is_text() && ws.send(message).await.is_err() {
                            break;
                        }
                    }
                }));
            }
            for stage in [0, 1, 0, 1] {
                let mut first = None;
                if stage == 1 {
                    let (tcp, _) = listener.accept().await.unwrap();
                    let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
                    ws.next().await.unwrap().unwrap();
                    first = Some(ws);
                }
                let (mut tcp, _) = listener.accept().await.unwrap();
                let mut request = [0; 2048];
                assert!(tcp.read(&mut request).await.unwrap() > 0);
                tcp.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")
                    .await
                    .unwrap();
                drop(first);
            }
            peers
        });
        let mut existing =
            connect_sockets(&profile, &test_token(), &json!({}), Duration::from_secs(1))
                .await
                .unwrap();
        for _ in 0..4 {
            assert!(
                connect_sockets(&profile, &test_token(), &json!({}), Duration::from_secs(1))
                    .await
                    .is_err()
            );
            for (ws, _) in &mut existing {
                ws.send(Message::Text("still connected".into()))
                    .await
                    .unwrap();
                assert_eq!(
                    tokio::time::timeout(Duration::from_secs(1), ws.next())
                        .await
                        .unwrap()
                        .unwrap()
                        .unwrap(),
                    Message::Text("still connected".into())
                );
            }
        }
        for peer in server.await.unwrap() {
            peer.abort();
        }
    }

    #[tokio::test]
    async fn handshake_auth_statuses_are_fixed_codes_on_either_socket() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for status in [401, 403, 503] {
            for rejected in 0..2 {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let profile = local_profile(listener.local_addr().unwrap());
                let server = tokio::spawn(async move {
                    let mut accepted = Vec::new();
                    for _ in 0..rejected {
                        let (tcp, _) = listener.accept().await.unwrap();
                        let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
                        ws.next().await.unwrap().unwrap();
                        accepted.push(ws);
                    }
                    let (mut tcp, _) = listener.accept().await.unwrap();
                    let mut request = Vec::new();
                    while !request.ends_with(b"\r\n\r\n") {
                        let mut byte = [0];
                        tcp.read_exact(&mut byte).await.unwrap();
                        request.push(byte[0]);
                        assert!(request.len() <= 4096);
                    }
                    tcp.write_all(
                        format!("HTTP/1.1 {status} Rejected\r\nContent-Length: 0\r\n\r\n")
                            .as_bytes(),
                    )
                    .await
                    .unwrap();
                    let mut byte = [0];
                    let _ = tokio::time::timeout(Duration::from_secs(5), tcp.read(&mut byte))
                        .await
                        .expect("client must close the rejected handshake");
                    for mut socket in accepted {
                        assert!(matches!(socket.next().await, Some(Ok(Message::Close(_)))));
                    }
                });
                let error =
                    connect_sockets(&profile, &test_token(), &json!({}), Duration::from_secs(1))
                        .await
                        .unwrap_err();
                if status == 503 {
                    assert_ne!(error, "AUTH_REJECTED");
                } else {
                    assert_eq!(error, "AUTH_REJECTED", "HTTP {status}, socket {rejected}");
                }
                server.await.unwrap();
            }
        }
    }

    #[tokio::test]
    async fn cancelled_connection_closes_both_sockets_without_installing_workers() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let profile = local_profile(listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut sockets = Vec::new();
            for _ in 0..2 {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                assert!(matches!(socket.next().await, Some(Ok(Message::Text(_)))));
                sockets.push(socket);
            }
            for mut socket in sockets {
                assert!(matches!(socket.next().await, Some(Ok(Message::Close(_)))));
            }
        });
        let transport = Arc::new(Mutex::new(()));
        let epoch = Arc::new(AtomicU64::new(1));
        let sockets = connect_sockets(&profile, &test_token(), &json!({}), Duration::from_secs(1))
            .await
            .unwrap();
        // Disconnect wins after both handshakes but before worker installation.
        epoch.fetch_add(1, Ordering::SeqCst);
        let lock = transport.clone();
        // Spawning also requires the production future to be Send across cleanup awaits.
        let cancelled = tokio::spawn(async move {
            install_connected_sockets(&lock, &epoch, 1, sockets, |_| {
                panic!("cancelled sockets must never install workers")
            })
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            assert_eq!(
                cancelled.await.unwrap().unwrap_err(),
                "Подключение отменено"
            );
            server.await.unwrap();
        })
        .await
        .unwrap();
        assert!(transport.try_lock().is_ok());
    }

    async fn worker_test_sockets() -> (
        tokio_tungstenite::WebSocketStream<tokio::io::DuplexStream>,
        tokio_tungstenite::WebSocketStream<tokio::io::DuplexStream>,
    ) {
        use tokio_tungstenite::tungstenite::protocol::Role;
        let (client, server) = tokio::io::duplex(4096);
        (
            tokio_tungstenite::WebSocketStream::from_raw_socket(client, Role::Client, None).await,
            tokio_tungstenite::WebSocketStream::from_raw_socket(server, Role::Server, None).await,
        )
    }

    #[tokio::test(start_paused = true)]
    async fn heartbeat_expires_exactly_at_timeout_despite_traffic_and_pings() {
        let (client, mut server) = worker_test_sockets().await;
        let (_tx, mut rx) = mpsc::unbounded_channel();
        let worker = tokio::spawn(async move {
            socket_worker(
                client,
                &mut rx,
                (Duration::from_secs(30), HEARTBEAT_TIMEOUT),
                || true,
                |_| true,
                || {},
            )
            .await
        });
        let start = tokio::time::Instant::now();
        assert!(server.next().await.unwrap().unwrap().is_text());
        for seconds in [30, 30, 14] {
            tokio::time::advance(Duration::from_secs(seconds)).await;
            server
                .send(Message::Text(json!({"type":"traffic"}).to_string().into()))
                .await
                .unwrap();
            tokio::task::yield_now().await;
            assert!(!worker.is_finished());
        }
        assert_eq!(
            tokio::time::Instant::now() - start,
            HEARTBEAT_TIMEOUT - Duration::from_secs(1)
        );
        tokio::time::advance(Duration::from_secs(1)).await;
        assert_eq!(worker.await.unwrap(), "transport");
        assert_eq!(tokio::time::Instant::now() - start, HEARTBEAT_TIMEOUT);
    }

    #[tokio::test(start_paused = true)]
    async fn pong_every_thirty_seconds_keeps_worker_alive() {
        let (client, mut server) = worker_test_sockets().await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let worker = tokio::spawn(async move {
            socket_worker(
                client,
                &mut rx,
                (Duration::from_secs(30), HEARTBEAT_TIMEOUT),
                || true,
                |_| true,
                || {},
            )
            .await
        });
        for _ in 0..10 {
            let ping = server.next().await.unwrap().unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&ping.into_text().unwrap()).unwrap()["type"],
                "ping"
            );
            server
                .send(Message::Text(json!({"type":"pong"}).to_string().into()))
                .await
                .unwrap();
            tokio::task::yield_now().await;
            tokio::time::advance(Duration::from_secs(30)).await;
            tokio::task::yield_now().await;
            assert!(!worker.is_finished());
        }
        drop(tx);
        worker.await.unwrap();
    }

    #[tokio::test]
    async fn worker_sends_close_on_channel_close_and_epoch_invalidation() {
        for invalidate in [false, true] {
            let (client, mut server) = worker_test_sockets().await;
            let (tx, mut rx) = mpsc::unbounded_channel();
            let current = Arc::new(AtomicBool::new(true));
            let epoch = current.clone();
            let worker = tokio::spawn(async move {
                socket_worker(
                    client,
                    &mut rx,
                    (Duration::from_secs(30), HEARTBEAT_TIMEOUT),
                    || epoch.load(Ordering::SeqCst),
                    |_| true,
                    || {},
                )
                .await
            });
            assert!(server.next().await.unwrap().unwrap().is_text());
            if invalidate {
                current.store(false, Ordering::SeqCst);
                server
                    .send(Message::Text(json!({"type":"revoked"}).to_string().into()))
                    .await
                    .unwrap();
            } else {
                drop(tx);
            }
            let close = tokio::time::timeout(Duration::from_secs(1), server.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert!(close.is_close());
            assert_eq!(worker.await.unwrap(), "closed");
        }
    }

    #[tokio::test]
    async fn revoked_from_either_worker_propagates_auth_and_cancels_peer() {
        for revoked in 0..2 {
            let revoked_flag = Arc::new(AtomicBool::new(false));
            let (client0, mut server0) = worker_test_sockets().await;
            let (client1, mut server1) = worker_test_sockets().await;
            let (tx0, mut rx0) = mpsc::unbounded_channel();
            let (tx1, mut rx1) = mpsc::unbounded_channel();
            let flag = revoked_flag.clone();
            let pair = tokio::spawn(async move {
                let timing = (Duration::from_secs(30), HEARTBEAT_TIMEOUT);
                let current: fn() -> bool = || true;
                let packet: fn(Value) -> bool = |_| true;
                let on_rev0 = move || {
                    flag.store(true, Ordering::SeqCst);
                };
                let on_rev1 = on_rev0.clone();
                run_socket_pair(futures_util::stream::FuturesUnordered::from_iter([
                    socket_worker(client0, &mut rx0, timing, current, packet, on_rev0),
                    socket_worker(client1, &mut rx1, timing, current, packet, on_rev1),
                ]))
                .await
            });
            server0.next().await.unwrap().unwrap();
            server1.next().await.unwrap().unwrap();
            let server = if revoked == 0 {
                &mut server0
            } else {
                &mut server1
            };
            server
                .send(Message::Text(json!({"type":"revoked"}).to_string().into()))
                .await
                .unwrap();
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(1), pair)
                    .await
                    .unwrap()
                    .unwrap(),
                Some("auth")
            );
            assert!(revoked_flag.load(Ordering::SeqCst));
            assert!(tx0.is_closed());
            assert!(tx1.is_closed());
        }
    }

    #[tokio::test]
    async fn close_frame_with_revoked_reason_propagates_auth() {
        use tokio_tungstenite::tungstenite::protocol::frame::CloseFrame;
        let (client, mut server) = worker_test_sockets().await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let revoked_flag = Arc::new(AtomicBool::new(false));
        let flag = revoked_flag.clone();
        let worker = tokio::spawn(async move {
            socket_worker(
                client,
                &mut rx,
                (Duration::from_secs(30), HEARTBEAT_TIMEOUT),
                || true,
                |_| true,
                move || flag.store(true, Ordering::SeqCst),
            )
            .await
        });
        assert!(server.next().await.unwrap().unwrap().is_text());
        server
            .send(Message::Close(Some(CloseFrame {
                code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Policy,
                reason: "revoked".into(),
            })))
            .await
            .unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), worker)
                .await
                .unwrap()
                .unwrap(),
            "auth"
        );
        assert!(revoked_flag.load(Ordering::SeqCst));
        drop(tx);
    }

    #[tokio::test]
    async fn real_websocket_close_terminates_both_workers() {
        for closing in 0..2 {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let profile = local_profile(listener.local_addr().unwrap());
            let (close_tx, close_rx) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let mut sockets = Vec::new();
                for _ in 0..2 {
                    let (tcp, _) = listener.accept().await.unwrap();
                    let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
                    ws.next().await.unwrap().unwrap();
                    sockets.push(ws);
                }
                close_rx.await.unwrap();
                sockets[closing].close(None).await.unwrap();
                // Both client TCP streams must disappear, including the blocked peer.
                for mut socket in sockets {
                    while let Some(Ok(Message::Text(_))) = socket.next().await {}
                }
            });
            let sockets =
                connect_sockets(&profile, &test_token(), &json!({}), Duration::from_secs(1))
                    .await
                    .unwrap();
            let (tx0, mut rx0) = mpsc::unbounded_channel();
            let (tx1, mut rx1) = mpsc::unbounded_channel();
            let mut sockets = sockets.into_iter();
            let worker = tokio::spawn(async move {
                run_socket_pair(futures_util::stream::FuturesUnordered::from_iter([
                    socket_worker(
                        sockets.next().unwrap().0,
                        &mut rx0,
                        (Duration::from_secs(30), HEARTBEAT_TIMEOUT),
                        (|| true) as fn() -> bool,
                        (|_| true) as fn(Value) -> bool,
                        (|| {}) as fn(),
                    ),
                    socket_worker(
                        sockets.next().unwrap().0,
                        &mut rx1,
                        (Duration::from_secs(30), HEARTBEAT_TIMEOUT),
                        (|| true) as fn() -> bool,
                        (|_| true) as fn(Value) -> bool,
                        (|| {}) as fn(),
                    ),
                ]))
                .await;
            });
            close_tx.send(()).unwrap();
            tokio::time::timeout(Duration::from_secs(2), worker)
                .await
                .unwrap()
                .unwrap();
            assert!(tx0.is_closed());
            assert!(tx1.is_closed());
            tokio::time::timeout(Duration::from_secs(2), server)
                .await
                .unwrap()
                .unwrap();
        }
    }

    #[tokio::test(start_paused = true)]
    async fn orderly_pair_shutdown_closes_both_sockets() {
        let workers = futures_util::stream::FuturesUnordered::new();
        let mut peers = Vec::new();
        for _ in 0..2 {
            let (client, peer) = worker_test_sockets().await;
            let (tx, mut rx) = mpsc::unbounded_channel();
            drop(tx);
            workers.push(async move {
                socket_worker(
                    client,
                    &mut rx,
                    (Duration::from_secs(30), HEARTBEAT_TIMEOUT),
                    || true,
                    |_| true,
                    || {},
                )
                .await
            });
            peers.push(peer);
        }
        assert_eq!(run_socket_pair(workers).await, Some("closed"));
        for mut peer in peers {
            loop {
                if matches!(peer.next().await.unwrap().unwrap(), Message::Close(_)) {
                    break;
                }
            }
        }
    }

    #[tokio::test]
    async fn real_wss_close_terminates_both_workers() {
        use tokio_rustls::rustls::{self, pki_types::PrivatePkcs8KeyDer};
        let cert = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let server_config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![cert.cert.der().clone()],
                PrivatePkcs8KeyDer::from(cert.key_pair.serialize_der()).into(),
            )
            .unwrap();
        let mut roots = rustls::RootCertStore::empty();
        roots.add(cert.cert.der().clone()).unwrap();
        let client_config = Arc::new(
            rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        );
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(server_config));
        for closed in [0, 1] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("wss://localhost:{}", listener.local_addr().unwrap().port());
            let acceptor = acceptor.clone();
            let server = tokio::spawn(async move {
                let mut peers = Vec::new();
                for _ in 0..2 {
                    let (stream, _) = listener.accept().await.unwrap();
                    let tls = acceptor.accept(stream).await.unwrap();
                    peers.push(tokio_tungstenite::accept_async(tls).await.unwrap());
                }
                peers[closed].close(None).await.unwrap();
                let peer = &mut peers[1 - closed];
                while let Some(Ok(_)) = peer.next().await {}
            });
            let mut sockets = Vec::new();
            for _ in 0..2 {
                sockets.push(
                    tokio_tungstenite::connect_async_tls_with_config(
                        &url,
                        None,
                        false,
                        Some(tokio_tungstenite::Connector::Rustls(client_config.clone())),
                    )
                    .await
                    .unwrap()
                    .0,
                );
            }
            let (_tx0, mut rx0) = mpsc::unbounded_channel();
            let (_tx1, mut rx1) = mpsc::unbounded_channel();
            let mut sockets = sockets.into_iter();
            let timing = (Duration::from_secs(30), HEARTBEAT_TIMEOUT);
            let current: fn() -> bool = || true;
            let packet: fn(Value) -> bool = |_| true;
            let on_rev: fn() = || {};
            tokio::time::timeout(
                Duration::from_secs(2),
                run_socket_pair(futures_util::stream::FuturesUnordered::from_iter([
                    socket_worker(
                        sockets.next().unwrap(),
                        &mut rx0,
                        timing,
                        current,
                        packet,
                        on_rev,
                    ),
                    socket_worker(
                        sockets.next().unwrap(),
                        &mut rx1,
                        timing,
                        current,
                        packet,
                        on_rev,
                    ),
                ])),
            )
            .await
            .expect("WSS close must stop both workers");
            tokio::time::timeout(Duration::from_secs(2), server)
                .await
                .unwrap()
                .unwrap();
        }
    }

    #[tokio::test]
    async fn real_worker_delayed_pong_and_traffic_do_not_extend_ping_deadline() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            assert!(ws.next().await.unwrap().unwrap().is_text());
            // Delay the first pong while application messages continue to arrive.
            for _ in 0..6 {
                ws.send(Message::Text(json!({"type":"traffic"}).to_string().into()))
                    .await
                    .unwrap();
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            ws.send(Message::Text(json!({"type":"pong"}).to_string().into()))
                .await
                .unwrap();
            let mut ticks = tokio::time::interval(Duration::from_millis(10));
            loop {
                ticks.tick().await;
                if ws
                    .send(Message::Text(json!({"type":"traffic"}).to_string().into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        let (ws, _) = connect_async(format!("ws://{address}")).await.unwrap();
        let (_tx, mut rx) = mpsc::unbounded_channel();
        let mut packets = 0;
        let start = tokio::time::Instant::now();
        tokio::time::timeout(
            Duration::from_secs(1),
            socket_worker(
                ws,
                &mut rx,
                (Duration::from_millis(50), Duration::from_millis(200)),
                || true,
                |_| {
                    packets += 1;
                    true
                },
                || {},
            ),
        )
        .await
        .unwrap();
        assert!(packets > 5);
        // Pong at 120ms clears the first deadline; the ping at 150ms starts the next.
        assert!(start.elapsed() >= Duration::from_millis(320));
        assert!(start.elapsed() < Duration::from_millis(600));
        server.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn either_socket_failure_drops_the_blocked_peer() {
        for failed in [0, 1] {
            let workers = futures_util::stream::FuturesUnordered::new();
            let mut receivers = Vec::new();
            for index in 0..2 {
                let (tx, rx) = tokio::sync::oneshot::channel::<()>();
                receivers.push(rx);
                workers.push(async move {
                    let _held = tx;
                    if index == failed {
                        tokio::task::yield_now().await;
                    } else {
                        std::future::pending::<()>().await;
                    }
                    "transport"
                });
            }
            run_socket_pair(workers).await;
            for rx in receivers {
                assert!(rx.await.is_err());
            }
        }
    }

    struct MockWriter {
        fail: bool,
    }

    impl futures_util::Sink<Message> for MockWriter {
        type Error = ();

        fn poll_ready(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), ()>> {
            if self.fail {
                std::task::Poll::Ready(Err(()))
            } else {
                std::task::Poll::Pending
            }
        }

        fn start_send(self: std::pin::Pin<&mut Self>, _: Message) -> Result<(), ()> {
            unreachable!()
        }

        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), ()>> {
            unreachable!()
        }

        fn poll_close(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), ()>> {
            unreachable!()
        }
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_socket_write_times_out() {
        let start = tokio::time::Instant::now();
        assert!(
            socket_send(&mut MockWriter { fail: false }, Message::Close(None))
                .await
                .is_err()
        );
        assert_eq!(start.elapsed(), WRITE_TIMEOUT);
    }

    #[tokio::test(start_paused = true)]
    async fn failed_socket_write_returns_immediately() {
        let start = tokio::time::Instant::now();
        assert!(
            socket_send(&mut MockWriter { fail: true }, Message::Close(None))
                .await
                .is_err()
        );
        assert_eq!(start.elapsed(), Duration::ZERO);
    }

    #[test]
    fn settings_retention_prunes_immediately_after_save() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        for directory in ["audit", "settings", "permissions"] {
            std::fs::create_dir_all(root.join(directory)).unwrap();
        }
        std::fs::write(
            root.join("audit/actions.json"),
            br#"[{"time":1,"tool":"old"},{"time":9999999999999,"tool":"fresh"}]"#,
        )
        .unwrap();

        let path = root.join("audit/actions.json");
        let before = std::fs::read(&path).unwrap();
        let settings = Settings {
            audit_days: 1,
            ..Settings::default()
        };
        let audit_lock = Mutex::new(());
        let result = save_settings_and_prune(
            &root,
            &audit_lock,
            Some(settings.audit_days),
            || Err("save failed".into()),
            || panic!("state must not change after a failed save"),
        );
        assert_eq!(result.unwrap_err(), "save failed");
        assert_eq!(std::fs::read(&path).unwrap(), before);

        save_settings_and_prune(
            &root,
            &audit_lock,
            Some(settings.audit_days),
            || {
                assert_eq!(std::fs::read(&path).unwrap(), before);
                storage::save(&root, &settings)
            },
            || {
                let saved: Value =
                    serde_json::from_slice(&std::fs::read(root.join("settings/app.json")).unwrap())
                        .unwrap();
                assert_eq!(saved["audit_days"], 1);
                assert_eq!(std::fs::read(&path).unwrap(), before);
                Ok(())
            },
        )
        .unwrap();

        let rows: Vec<Value> =
            serde_json::from_slice(&std::fs::read(root.join("audit/actions.json")).unwrap())
                .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["tool"], "fresh");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn active_tray_icon_carries_a_red_mark() {
        assert_ne!(TRAY_ICON, TRAY_ICON_ACTIVE);
        let idle = tray_icon(false).unwrap();
        let active = tray_icon(true).unwrap();
        assert_eq!(idle.width(), active.width());
        assert_eq!(idle.height(), active.height());
        let red = |px: &[u8; 4]| px[0] > 180 && px[1] < 80 && px[2] < 80 && px[3] > 200;
        assert!(active.rgba().as_chunks::<4>().0.iter().any(red));
        assert!(!idle.rgba().as_chunks::<4>().0.iter().any(red));
    }
    #[test]
    fn live_events_carry_the_run_that_started_them() {
        let stamped = with_run(json!({"type":"listening"}), 4);
        assert_eq!(stamped["run"], 4);
        assert_eq!(stamped["type"], "listening");
    }
    #[test]
    fn server_profile_retains_proxy_prefix_and_rejects_credentials() {
        let mut p = Profile {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Test".into(),
            url: "https://example.com/api".into(),
            session_id: uuid::Uuid::new_v4().to_string(),
        };
        assert_eq!(
            server_url(&p, "/v1/health").unwrap().as_str(),
            "https://example.com/api/v1/health"
        );
        assert_eq!(
            server_url(&p, "/v1/logs?source=system&tail=200")
                .unwrap()
                .as_str(),
            "https://example.com/api/v1/logs?source=system&tail=200"
        );
        for bad in [
            "http://example.com",
            "https://name:secret@example.com",
            "https://example.com?token=bad",
            "file:///tmp/server",
        ] {
            p.url = bad.into();
            assert!(server_url(&p, "/v1/health").is_err());
        }
    }

    #[test]
    fn profile_hash_prevents_path_traversal_and_leakage() {
        assert_eq!(
            profile_hash(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            profile_hash("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );

        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        for malicious_id in [
            "../../etc/passwd",
            "../secrets",
            "foo/bar",
            "foo\\bar",
            "CON",
            "",
            "id with spaces and $pecial! chars",
        ] {
            let marker = revoked_marker(&root, malicious_id);
            assert_eq!(marker.parent().unwrap(), &root);
            let filename = marker.file_name().unwrap().to_str().unwrap();
            assert!(filename.starts_with("device-revoked-"));
            let hash = &filename["device-revoked-".len()..];
            assert_eq!(hash.len(), 64);
            assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
            assert!(!filename.contains("etc"));
            assert!(!filename.contains("passwd"));
            assert!(!filename.contains(".."));
            assert!(!filename.contains('/'));
            assert!(!filename.contains('\\'));
        }
    }

    #[test]
    fn profile_revoke_isolation_and_lifecycle() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let profile_a = "profile-alpha";
        let profile_b = "profile-beta";

        // 1. Initial state: neither is revoked
        assert!(!revoked_pending(&root, profile_a));
        assert!(!revoked_pending(&root, profile_b));

        // 2. Mark profile A revoked
        mark_revoked(&root, profile_a).unwrap();
        assert!(revoked_pending(&root, profile_a));
        assert!(revoked_marker(&root, profile_a).exists());
        assert!(!revoked_pending(&root, profile_b));
        assert!(!revoked_marker(&root, profile_b).exists());

        // 3. Connect/clear profile B must NOT clear profile A
        clear_revoked(&root, profile_b).unwrap();
        assert!(revoked_pending(&root, profile_a));
        assert!(revoked_marker(&root, profile_a).exists());
        assert!(!revoked_pending(&root, profile_b));

        // 4. Clearing profile A removes marker and clears status
        clear_revoked(&root, profile_a).unwrap();
        assert!(!revoked_pending(&root, profile_a));
        assert!(!revoked_marker(&root, profile_a).exists());

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn cancelled_install_retains_revoked_state() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let profile_a = "profile-retain-on-cancel";

        mark_revoked(&root, profile_a).unwrap();
        assert!(revoked_pending(&root, profile_a));

        let transport = Mutex::new(());
        let current_epoch = AtomicU64::new(42);
        let mut install_ran = false;

        // Attempt install with an epoch mismatch (cancelled connection)
        let res = install_connected_sockets(
            &transport,
            &current_epoch,
            41, // mismatched epoch
            vec![],
            |_| {
                install_ran = true;
                clear_revoked(&root, profile_a)
            },
        )
        .await;

        assert!(res.is_err());
        assert_eq!(res.unwrap_err(), "Подключение отменено");
        assert!(!install_ran);
        assert!(revoked_pending(&root, profile_a));
        assert!(revoked_marker(&root, profile_a).exists());

        clear_revoked(&root, profile_a).unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn failed_reauth_clear_flushes_close_instead_of_dropping_sockets() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let profile = local_profile(listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut sockets = Vec::new();
            for _ in 0..2 {
                let (tcp, _) = listener.accept().await.unwrap();
                let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
                assert!(ws.next().await.unwrap().unwrap().is_text());
                sockets.push(ws);
            }
            // A socket that already passed the handshake must be closed with a
            // Close frame, not dropped as a bare TCP disconnect.
            for mut ws in sockets {
                match tokio::time::timeout(Duration::from_secs(2), ws.next()).await {
                    Ok(Some(Ok(Message::Close(_)))) => {}
                    other => panic!("expected Close frame, got {other:?}"),
                }
            }
        });
        let sockets = connect_sockets(&profile, &test_token(), &json!({}), Duration::from_secs(1))
            .await
            .unwrap();

        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let profile_id = "profile-close-on-failed-clear";
        mark_revoked(&root, profile_id).unwrap();
        // Block removal deterministically: the marker path becomes a directory.
        std::fs::remove_file(revoked_marker(&root, profile_id)).unwrap();
        std::fs::create_dir_all(revoked_marker(&root, profile_id)).unwrap();

        let transport = Mutex::new(());
        let current_epoch = AtomicU64::new(7);
        let result = install_connected_sockets(&transport, &current_epoch, 7, sockets, |sockets| {
            apply_connection_install(&root, profile_id, true, || {
                let _installed = sockets.take().unwrap();
                Ok(())
            })
        })
        .await;

        assert!(result.is_err());
        assert!(revoked_pending(&root, profile_id));
        server.await.unwrap();

        std::fs::remove_dir(revoked_marker(&root, profile_id)).unwrap();
        clear_revoked(&root, profile_id).unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn recreate_state_reads_disk_marker() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let profile_a = "profile-persists";

        mark_revoked(&root, profile_a).unwrap();
        assert!(revoked_marker(&root, profile_a).exists());

        // Simulate app restart / recreated state by clearing in-memory cache
        clear_all_revoked_seen();
        assert!(!is_revoked_seen(profile_a));

        // State check reads from disk marker
        assert!(revoked_pending(&root, profile_a));

        clear_revoked(&root, profile_a).unwrap();
        assert!(!revoked_pending(&root, profile_a));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn io_errors_not_swallowed() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();

        // 1. Write error: root is a file rather than a directory
        let file_as_root = root.join("file_blocker");
        std::fs::write(&file_as_root, b"blocking file").unwrap();
        let write_res = mark_revoked(&file_as_root, "profile-error");
        assert!(write_res.is_err());

        // 2. Delete error: marker path is a directory, so fs::remove_file deterministically fails
        let profile_dir_blocker = "profile-dir-as-marker";
        let blocker_path = revoked_marker(&root, profile_dir_blocker);
        std::fs::create_dir_all(&blocker_path).unwrap();
        assert!(blocker_path.is_dir());

        let del_res = clear_revoked(&root, profile_dir_blocker);
        assert!(del_res.is_err());
        assert!(blocker_path.exists());

        std::fs::remove_dir(&blocker_path).unwrap();
        let del_ok = clear_revoked(&root, profile_dir_blocker);
        assert!(del_ok.is_ok());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn reauth_clear_precedes_transport_install() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let profile = "profile-atomic-install";

        // Success path: the marker is already gone when the install step runs,
        // so a later install failure cannot lose the revoke state.
        mark_revoked(&root, profile).unwrap();
        apply_connection_install(&root, profile, true, || {
            assert!(!revoked_pending(&root, profile));
            Ok(())
        })
        .unwrap();

        // Without reauth the marker is left untouched.
        mark_revoked(&root, profile).unwrap();
        apply_connection_install(&root, profile, false, || Ok(())).unwrap();
        assert!(revoked_pending(&root, profile));

        // Failure path: a marker path blocked by a directory makes the removal
        // fail deterministically; the install step must not run at all, so no
        // half-installed state (active profile without workers) can appear.
        std::fs::remove_file(revoked_marker(&root, profile)).unwrap();
        let blocker = revoked_marker(&root, profile);
        std::fs::create_dir_all(&blocker).unwrap();
        let mut install_ran = false;
        let res = apply_connection_install(&root, profile, true, || {
            install_ran = true;
            Ok(())
        });
        assert!(res.is_err());
        assert!(!install_ran);
        assert!(revoked_pending(&root, profile));

        std::fs::remove_dir(&blocker).unwrap();
        clear_revoked(&root, profile).unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn server_url_rejects_invalid_inputs_and_handles_queries_safely() {
        let mut p = Profile {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Test".into(),
            url: "https://example.com/api".into(),
            session_id: uuid::Uuid::new_v4().to_string(),
        };
        let u = server_url(&p, "/v1/logs?source=plugin%3Atelegram&tail=500").unwrap();
        assert_eq!(
            u.as_str(),
            "https://example.com/api/v1/logs?source=plugin%3Atelegram&tail=500"
        );
        assert_eq!(u.query(), Some("source=plugin%3Atelegram&tail=500"));

        for bad in [
            "",
            "not a url",
            "ftp://example.com",
            "http://remote.example.com",
            "https://user:pass@example.com",
            "https://example.com#section",
            "https://example.com?query=value",
            "javascript:alert(1)",
        ] {
            p.url = bad.into();
            assert!(
                server_url(&p, "/v1/logs?source=system").is_err(),
                "Expected error for {bad}"
            );
        }
    }
}
