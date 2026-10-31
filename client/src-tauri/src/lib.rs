mod audio;
mod audit;
mod command_runner;
mod commands;
mod host;
mod logs;
mod policy;
mod storage;

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use policy::{Decision, ToolCall};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use storage::{Profile, Settings};
use tauri::{Emitter, Manager, State};
use tokio::sync::mpsc::{self, UnboundedSender};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};

type SocketSender = UnboundedSender<Message>;
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
    audit_lock: Mutex<()>,
    shortcuts: AtomicBool,
    screen_locked: AtomicBool,
    current_turn: Mutex<Option<String>>,
    commands: Mutex<commands::Store>,
    waiters: Mutex<HashMap<String, tokio::sync::oneshot::Sender<Value>>>,
    drafts: Mutex<HashMap<String, commands::Command>>,
    hotkeys: Mutex<HashMap<u32, (String, tauri_plugin_global_shortcut::Shortcut)>>,
    hotkey_backend: AtomicBool,
    running: Mutex<Option<String>>,
    pending_import: Mutex<Option<command_runner::PendingImport>>,
    recoveries: Mutex<Vec<storage::Recovery>>,
}
fn lock_error<T>(_: std::sync::PoisonError<T>) -> String {
    "Внутренняя ошибка состояния".into()
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
    u.set_path(&format!("{}{}", u.path().trim_end_matches('/'), path));
    Ok(u)
}
fn manifest(state: &Desktop, p: &Profile) -> Result<Value, String> {
    let s = state.settings.lock().map_err(lock_error)?;
    let platform = if cfg!(windows) {
        "windows"
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
        json!({"settings":*s,"data_root":state.root,"platform":std::env::consts::OS,"global_shortcuts":state.shortcuts.load(Ordering::SeqCst),"hotkeys_available":state.hotkey_backend.load(Ordering::SeqCst),"pc_access_available":!state.screen_locked.load(Ordering::SeqCst),"recoveries":recoveries}),
    )
}
#[tauri::command]
async fn save_settings(state: State<'_, Desktop>, settings: Settings) -> Result<(), String> {
    apply_settings(&state, settings)
}

fn apply_settings(state: &Desktop, settings: Settings) -> Result<(), String> {
    let old = state.settings.lock().map_err(lock_error)?.clone();
    if settings.schema_version != storage::SETTINGS_VERSION
        || settings.device_id != old.device_id
        || settings.profiles.len() > 12
        || settings.device_name.len() > 80
        || settings.device_name.trim().is_empty()
        || !matches!(settings.theme.as_str(), "dark" | "light")
        || !(1..=365).contains(&settings.audit_days)
        || !matches!(
            settings.graphics_mode.as_str(),
            "auto" | "wayland" | "wayland-nvidia" | "x11" | "compatibility"
        )
    {
        return Err("Неверные настройки".into());
    }
    if settings.permissions.web_domains.len() > 50 || settings.permissions.apps.len() > 200 {
        return Err("Слишком большой allowlist".into());
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
    let changed = serde_json::to_value(&old.permissions).ok()
        != serde_json::to_value(&settings.permissions).ok();
    storage::save(&state.root, &settings)?;
    *state.settings.lock().map_err(lock_error)? = settings;
    if changed {
        stop_inner(state)?;
        send_capabilities(state);
    }
    Ok(())
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
    if token.len() < 8 || token.len() > 4096 || token.contains(['\n', '\r']) {
        return Err("Неверный токен".into());
    }
    storage::secret(&profile_id)?
        .set_password(&token)
        .map_err(|_| "Не удалось сохранить токен: разблокируйте системное хранилище".into())
}

#[tauri::command]
async fn api(
    state: State<'_, Desktop>,
    profile_id: String,
    path: String,
    method: String,
) -> Result<Value, String> {
    let allowed = matches!(
        (method.as_str(), path.as_str()),
        (
            "GET",
            "/v1/health" | "/v1/status" | "/v1/plugins" | "/openapi.json"
        ) | ("POST", "/v1/system/restart")
    );
    if !allowed {
        return Err("API-действие недоступно".into());
    }
    let p = profile(&state, &profile_id)?;
    let url = server_url(&p, &path)?;
    let token = storage::secret(&profile_id)?
        .get_password()
        .map_err(|_| "Сначала сохраните токен")?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
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
    let token = storage::secret(&profile_id)?
        .get_password()
        .map_err(|_| "Токен не найден")?;
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
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
    disconnect_inner(&state)?;
    let p = profile(&state, &profile_id)?;
    let token = storage::secret(&profile_id)?
        .get_password()
        .map_err(|_| "Сначала сохраните токен")?;
    let epoch = state.epoch.load(Ordering::SeqCst);
    let hello = manifest(&state, &p)?;
    let mut sockets = Vec::new();
    for (path, kind) in [
        ("/v1/desktop/bridge", "bridge"),
        ("/v1/desktop/voice", "voice"),
    ] {
        let mut url = server_url(&p, path)?;
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme).map_err(|_| "Неверный адрес")?;
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|_| "Неверный адрес")?;
        request.headers_mut().insert(
            "Authorization",
            format!("Bearer {token}")
                .parse()
                .map_err(|_| "Неверный токен")?,
        );
        let (mut ws, _) =
            tokio::time::timeout(std::time::Duration::from_secs(15), connect_async(request))
                .await
                .map_err(|_| "Сервер не ответил")?
                .map_err(|_| "Подключение отклонено; проверьте токен и версию сервера")?;
        ws.send(Message::Text(hello.to_string().into()))
            .await
            .map_err(|_| "Подключение закрыто")?;
        sockets.push((ws, kind));
    }
    *state.active_profile.lock().map_err(lock_error)? = Some(profile_id);
    for (ws, kind) in sockets {
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        if kind == "bridge" {
            *state.bridge.lock().map_err(lock_error)? = Some(tx);
        } else {
            *state.voice.lock().map_err(lock_error)? = Some(tx);
        }
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let (mut writer, mut reader) = ws.split();
            let mut wav = Vec::new();
            let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(30));
            loop {
                if handle.state::<Desktop>().epoch.load(Ordering::SeqCst) != epoch {
                    let _ = writer.send(Message::Close(None)).await;
                    break;
                }
                tokio::select! {
                                    message=rx.recv()=>{match message{Some(m)=>{if writer.send(m).await.is_err(){break;}},None=>break}},
                                    _=heartbeat.tick()=>{if writer.send(Message::Text(json!({"type":"ping"}).to_string().into())).await.is_err(){break;}},
                                    message=reader.next()=>{
                                        match message{
                                            Some(Ok(Message::Text(text)))=>{
                                                if text.len()>100000{break;}
                                if handle.state::<Desktop>().epoch.load(Ordering::SeqCst)!=epoch{break;}
                                                let Ok(mut packet)=serde_json::from_str::<Value>(&text) else {break;};
                                if let Some(object)=packet.as_object_mut(){object.insert("source".into(),json!(kind));}
                                                if let Some(request_id)=packet["request_id"].as_str(){
                                    let state=handle.state::<Desktop>();
                                    let current=state.current_turn.lock().ok().and_then(|t|t.clone());
                                    if current.as_deref()!=Some(request_id){continue;}
                                    if packet["type"]=="error" || packet["type"]=="cancelled" || packet["type"]=="audio.done" || packet["type"]=="command_match" || (kind=="bridge"&&packet["type"]=="done") {if let Ok(mut t)=state.current_turn.lock(){*t=None;}}
                                }
                                match packet["type"].as_str(){
                                                    Some("client_tool_call")=>{let mut data=packet.clone();if let Some(o)=data.as_object_mut(){o.remove("type");o.remove("protocol");o.remove("source");}
                if let Ok(call)=serde_json::from_value::<ToolCall>(data){receive_call(handle.clone(),call);}},
                                                    Some("revoked")=>{break;},
                                                    Some("command_draft")=>{if kind=="bridge"{command_runner::receive_draft(&handle,&packet);}},
                                                    Some("command_match")=>{
                                                        // Only the authenticated voice socket may ask for a local command; the name is looked up locally.
                                                        if kind=="voice"{if let Some(name)=packet["name"].as_str(){command_runner::run_by_name(handle.clone(),name.to_string(),"voice");}}
                                                        let _=handle.emit("desktop-event",packet);
                                                    },
                                    Some("cancel")=>{
                                        // Per-call cancel must not become global Stop (AR-3).
                                        let state=handle.state::<Desktop>();
                                        if let Some(call_id)=packet["call_id"].as_str(){
                                            if let Ok(mut pending)=state.pending.lock(){
                                                if let Some(call)=pending.remove(call_id){
                                                    drop(pending);
                                                    reply(&handle,&call,json!({"status":"denied","code":"cancelled"}),false);
                                                    let _=handle.emit("host-confirm-closed",json!({"call_id":call.call_id}));
                                                }
                                            }
                                        }
                                    },
                                                    Some("audio.chunk")=>{if let Some(data)=packet["data"].as_str(){if let Ok(bytes)=base64::engine::general_purpose::STANDARD.decode(data){if wav.len()+bytes.len()>8*1024*1024{break;}wav.extend(bytes);}}},
                                                    Some("audio.done")=>{let state=handle.state::<Desktop>();let output_handle=handle.clone();let _=audio::play(std::mem::take(&mut wav),state.generation.clone(),move|code|{let _=output_handle.emit("desktop-event",if code=="audio_finished"{json!({"type":"audio.finished"})}else{json!({"type":"error","code":code})});});let _=handle.emit("desktop-event",json!({"type":"speaking"}));},
                                                    Some("cancelled")=>{wav.clear();let _=handle.emit("desktop-event",packet);},
                                                    _=>{let _=handle.emit("desktop-event",packet);}
                                                }
                                            },Some(Ok(Message::Ping(bytes)))=>{if writer.send(Message::Pong(bytes)).await.is_err(){break;}},Some(Ok(Message::Close(_)))|None|Some(Err(_))=>break,_=>{}
                                        }
                                    }
                                }
            }
            let state = handle.state::<Desktop>();
            if state.epoch.load(Ordering::SeqCst) == epoch {
                let _ = disconnect_inner(&state);
                let _ = handle.emit("desktop-event", json!({"type":"disconnected"}));
            }
        });
    }
    Ok(())
}

fn receive_call(app: tauri::AppHandle, call: ToolCall) {
    let state = app.state::<Desktop>();
    if state.screen_locked.load(Ordering::SeqCst) {
        reply(
            &app,
            &call,
            json!({"status":"denied","code":"session_locked"}),
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
            &settings.device_id,
            &p.session_id,
            &mut seen,
        )
    })();
    match decision {
        Ok(Decision::Safe) => execute_call(app.clone(), call, false),
        Ok(Decision::Confirm) => {
            if !queue_confirm(&app, call.clone()) {
                reply(&app, &call, json!({"status":"denied"}), false);
            }
        }
        Err(_) => reply(&app, &call, json!({"status":"denied"}), false),
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
    let _ = app.emit("host-confirm", &call);
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
                json!({"status":"denied","code":"confirmation_expired"}),
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
    if let Ok(_guard) = state.audit_lock.lock() {
        let _ = audit::append(
            &state.root,
            &call.tool,
            result["status"].as_str().unwrap_or("error"),
            confirmed,
            days,
        );
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
            &settings.device_id,
            &session,
            &mut HashMap::new(),
        )
    })();
    if current_check.is_err() || cancel.load(Ordering::SeqCst) {
        reply(&app, &call, json!({"status":"denied"}), confirmed);
        return;
    }
    let _ = app.emit("host-activity", json!({"active":true,"tool":call.tool}));
    tauri::async_runtime::spawn(async move {
        let c = call.clone();
        let result = tauri::async_runtime::spawn_blocking(move || host::execute(&c, cancel)).await;
        let value = match result {
            Ok(Ok(v)) => v,
            _ => json!({"status":"error","code":"local_action_failed"}),
        };
        reply(&app, &call, value, confirmed);
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
        reply(&app, &call, json!({"status":"denied"}), false);
        return Ok(());
    }
    if call.tool == command_runner::CONFIRM_TOOL && is_local(&call) {
        // Command-level consent only; every action is still checked by the PC policy on its own.
        reply(&app, &call, json!({"status":"ok"}), true);
        return Ok(());
    }
    let settings = state.settings.lock().map_err(lock_error)?.clone();
    let session = expected_session(&state, &settings, &call)?;
    policy::validate(
        &call,
        &settings.permissions,
        &settings.device_id,
        &session,
        &mut HashMap::new(),
    )?;
    execute_call(app, call, true);
    Ok(())
}
#[tauri::command]
fn chat(
    app: tauri::AppHandle,
    state: State<'_, Desktop>,
    text: String,
    target_device_id: Option<String>,
) -> Result<Value, String> {
    if text.trim().is_empty() || text.len() > 6000 {
        return Err("Сообщение должно содержать 1–6000 символов".into());
    }
    // An exact quick-command phrase runs locally without a model turn; anything else goes to the server.
    if let Some(handled) = command_runner::try_phrase(&app, &state, &text)? {
        return Ok(handled);
    }
    if state.recording.lock().map_err(lock_error)?.is_some() {
        return Err("Сначала завершите запись".into());
    }
    let request_id = start_turn(&state)?;
    let result = send(
        &state.bridge,
        json!({"type":"chat","text":text,"target_device_id":target_device_id,"request_id":request_id}),
    );
    if result.is_err() {
        *state.current_turn.lock().map_err(lock_error)? = None;
    }
    result.map(|_| json!({"handled":false}))
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
fn start_turn(state: &Desktop) -> Result<String, String> {
    let mut current = state.current_turn.lock().map_err(lock_error)?;
    if current.is_some() {
        return Err("Сначала дождитесь ответа или нажмите Stop".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    *current = Some(id.clone());
    Ok(id)
}
fn stop_inner(state: &Desktop) -> Result<(), String> {
    state.generation.fetch_add(1, Ordering::SeqCst);
    *state.current_turn.lock().map_err(lock_error)? = None;
    let mut cancel = state.cancelled.lock().map_err(lock_error)?;
    cancel.store(true, Ordering::SeqCst);
    *cancel = Arc::new(AtomicBool::new(false));
    state.pending.lock().map_err(lock_error)?.clear();
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
    app.emit("desktop-event", json!({"type":"cancelled"}))
        .map_err(|_| "Ошибка окна".into())
}
#[tauri::command]
fn disconnect(state: State<'_, Desktop>) -> Result<(), String> {
    disconnect_inner(&state)
}
#[tauri::command]
async fn record_start(state: State<'_, Desktop>) -> Result<(), String> {
    if state.current_turn.lock().map_err(lock_error)?.is_some() {
        return Err("Дождитесь ответа или нажмите Stop".into());
    }
    if state.voice.lock().map_err(lock_error)?.is_none() {
        return Err("Нет голосового подключения".into());
    }
    state.generation.fetch_add(1, Ordering::SeqCst);
    let mut recording = state.recording.lock().map_err(lock_error)?;
    if recording.is_some() {
        return Err("Запись уже идёт".into());
    }
    *recording = Some(audio::Recording::start()?);
    Ok(())
}
#[tauri::command]
async fn record_stop(state: State<'_, Desktop>) -> Result<(), String> {
    let recording = state
        .recording
        .lock()
        .map_err(lock_error)?
        .take()
        .ok_or("Нет записи")?;
    let request_id = start_turn(&state)?;
    let result = async {
        let pcm = tauri::async_runtime::spawn_blocking(move || recording.finish())
            .await
            .map_err(|_| "Ошибка записи".to_string())??;
        let tx = state
            .voice
            .lock()
            .map_err(lock_error)?
            .clone()
            .ok_or_else(|| "Нет голосового подключения".to_string())?;
        for chunk in pcm.chunks(32000) {
            tx.send(Message::Binary(chunk.to_vec().into()))
                .map_err(|_| "Подключение закрыто".to_string())?;
        }
        tx.send(Message::Text(
            json!({"type":"commit","request_id":request_id})
                .to_string()
                .into(),
        ))
        .map_err(|_| "Подключение закрыто".to_string())?;
        Ok::<(), String>(())
    }
    .await;
    if result.is_err() {
        // Clear sticky turn on any failure after start_turn (AR-8).
        if let Ok(mut current) = state.current_turn.lock() {
            *current = None;
        }
    }
    result
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

pub fn run() {
    #[cfg(target_os = "linux")]
    apply_graphics();
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let root = storage::data_root().map_err(std::io::Error::other)?;
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
            audit::prune(&root, settings.audit_days).map_err(std::io::Error::other)?;
            app.manage(Desktop {
                root,
                settings: Mutex::new(settings),
                bridge: Mutex::new(None),
                voice: Mutex::new(None),
                active_profile: Mutex::new(None),
                seen: Mutex::new(HashMap::new()),
                pending: Mutex::new(HashMap::new()),
                cancelled: Mutex::new(Arc::new(AtomicBool::new(false))),
                generation: Arc::new(AtomicU64::new(0)),
                recording: Mutex::new(None),
                epoch: AtomicU64::new(0),
                audit_lock: Mutex::new(()),
                shortcuts: AtomicBool::new(false),
                screen_locked: AtomicBool::new(true),
                current_turn: Mutex::new(None),
                commands: Mutex::new(commands::Store::default()),
                waiters: Mutex::new(HashMap::new()),
                drafts: Mutex::new(HashMap::new()),
                hotkeys: Mutex::new(HashMap::new()),
                hotkey_backend: AtomicBool::new(false),
                running: Mutex::new(None),
                pending_import: Mutex::new(None),
                recoveries: Mutex::new(recoveries),
            });
            monitor_session(app.handle().clone());
            setup_shortcuts(app.handle());
            command_runner::start_watcher(app.handle().clone());
            let open =
                tauri::menu::MenuItem::with_id(app, "open", "Открыть Neyra", true, None::<&str>)?;
            let stop = tauri::menu::MenuItem::with_id(app, "stop", "Stop", true, None::<&str>)?;
            let quit = tauri::menu::MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&open, &stop, &quit])?;
            tauri::tray::TrayIconBuilder::new()
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
                        let _ = app.emit("desktop-event", json!({"type":"cancelled"}));
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
            chat,
            bridge_message,
            disconnect_device,
            approve,
            stop,
            record_start,
            record_stop,
            audit_log,
            applications,
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
            command_runner::choose_data_root
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
                let _ = app.emit("desktop-event", json!({"type":"cancelled"}));
            } else if shortcut.key == Code::Space {
                let handle = app.clone();
                let pressed = event.state == ShortcutState::Pressed;
                tauri::async_runtime::spawn(async move {
                    let state = handle.state::<Desktop>();
                    let result = if pressed {
                        record_start(state).await
                    } else {
                        record_stop(state).await
                    };
                    match result {
                        Ok(()) => {
                            let _ = handle.emit(
                                "desktop-event",
                                json!({"type":if pressed{"recording"}else{"transcribing"}}),
                            );
                        }
                        Err(_) => {
                            let _ = handle.emit(
                                "desktop-event",
                                json!({"type":"error","code":"microphone_unavailable"}),
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
                let _ = app.emit("desktop-event", json!({"type":"cancelled"}));
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
}
