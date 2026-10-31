//! Runs quick commands locally (text, voice match, hotkey, UI button) and owns the commands IPC.
//! Every action goes through the same PC policy, confirmation cards, Stop and audit as server calls.

use crate::{
    apply_settings, commands, execute_call, lock_error, logs, policy, queue_confirm, reply, send,
    send_capabilities, storage, Desktop,
};
use commands::{Command, Conflict, Match};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

pub const CONFIRM_TOOL: &str = "command.run";
const STEP_TIMEOUT: Duration = Duration::from_secs(45);
const IMPORT_TTL: Duration = Duration::from_secs(600);

pub struct PendingImport {
    bundle: commands::Bundle,
    commands: Vec<Command>,
    created: Instant,
}

fn dir(state: &Desktop) -> PathBuf {
    state.root.join("commands")
}

fn reload(state: &Desktop) -> Result<bool, String> {
    let mut store = state.commands.lock().map_err(lock_error)?;
    Ok(store.reload(&dir(state)))
}

fn ensure_loaded(state: &Desktop) -> Result<(), String> {
    let d = dir(state);
    let mut store = state.commands.lock().map_err(lock_error)?;
    if store.dirty(&d) {
        store.reload(&d);
    }
    Ok(())
}

fn ensure_writable(state: &Desktop) -> Result<(), String> {
    if state.relocated.load(Ordering::SeqCst) {
        return Err(
            "Папка данных сменится после перезапуска. До перезапуска сохранение отключено.".into(),
        );
    }
    Ok(())
}

fn registered_ids(state: &Desktop) -> Vec<u32> {
    state
        .hotkeys
        .lock()
        .map(|m| m.keys().copied().collect())
        .unwrap_or_default()
}

fn hotkey_view(registered: &[u32], command: &Command) -> Vec<Value> {
    command
        .triggers
        .iter()
        .filter_map(|t| t.hotkey.as_deref())
        .filter_map(|h| commands::canonical_hotkey(h).ok())
        .map(|h| {
            let ok = h
                .parse::<Shortcut>()
                .is_ok_and(|s| registered.contains(&s.id()));
            json!({"hotkey": h, "registered": ok})
        })
        .collect()
}

fn view(state: &Desktop) -> Result<Value, String> {
    // Never hold the hotkey lock while taking the commands lock (and vice versa): sync_hotkeys does the reverse.
    let registered = registered_ids(state);
    let store = state.commands.lock().map_err(lock_error)?;
    let items: Vec<Value> = store
        .entries()
        .iter()
        .map(|e| json!({"file": e.file, "command": e.command, "hotkeys": hotkey_view(&registered, &e.command)}))
        .collect();
    Ok(json!({
        "commands": items,
        "errors": store.errors(),
        "hotkeys_available": state.hotkey_backend.load(Ordering::SeqCst),
        "folder": dir(state),
        "max_commands": commands::MAX_COMMANDS,
    }))
}

/// Reload from disk, then refresh hotkeys, the server's runtime view and the UI when anything changed.
fn after_change(app: &tauri::AppHandle) {
    let state = app.state::<Desktop>();
    if reload(&state).unwrap_or(false) {
        sync_hotkeys(app);
        send_capabilities(&state);
        if let Ok(v) = view(&state) {
            let count = v["errors"].as_array().map_or(0, Vec::len);
            if count > 0 {
                logs::log(
                    &state.root,
                    "warn",
                    &format!("commands reload errors={count}"),
                );
            }
            let _ = app.emit("commands-changed", v);
        }
    }
}

/// Polling (not OS file events): works the same on OneDrive/network folders and needs no extra dependency.
pub fn start_watcher(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        let dirty = {
            let state = app.state::<Desktop>();
            let d = dir(&state);
            state.commands.lock().map(|s| s.dirty(&d)).unwrap_or(false)
        };
        if dirty {
            after_change(&app);
        }
        std::thread::sleep(Duration::from_millis(1500));
    });
}

fn sync_hotkeys(app: &tauri::AppHandle) {
    let state = app.state::<Desktop>();
    if !state.hotkey_backend.load(Ordering::SeqCst) {
        return;
    }
    let shortcuts = app.global_shortcut();
    let Ok(mut map) = state.hotkeys.lock() else {
        return;
    };
    for (_, (_, shortcut)) in map.drain() {
        let _ = shortcuts.unregister(shortcut);
    }
    let entries = state
        .commands
        .lock()
        .map(|s| s.entries().to_vec())
        .unwrap_or_default();
    for entry in entries.iter().filter(|e| e.command.enabled) {
        for trigger in &entry.command.triggers {
            let Some(hotkey) = trigger
                .hotkey
                .as_deref()
                .and_then(|h| commands::canonical_hotkey(h).ok())
            else {
                continue;
            };
            let Ok(shortcut) = hotkey.parse::<Shortcut>() else {
                continue;
            };
            if shortcuts.register(shortcut).is_ok() {
                map.insert(shortcut.id(), (entry.command.name.clone(), shortcut));
            }
        }
    }
}

pub fn hotkey_command(app: &tauri::AppHandle, id: u32) -> Option<String> {
    app.state::<Desktop>()
        .hotkeys
        .lock()
        .ok()
        .and_then(|m| m.get(&id).map(|(name, _)| name.clone()))
}

fn emit_run(app: &tauri::AppHandle, payload: Value) {
    let _ = app.emit("command-run", payload);
}

pub fn run_by_name(app: tauri::AppHandle, name: String, source: &'static str) {
    let state = app.state::<Desktop>();
    let _ = ensure_loaded(&state);
    let found = state.commands.lock().ok().and_then(|s| {
        s.entries()
            .iter()
            .find(|e| e.command.enabled && e.command.name.to_lowercase() == name.to_lowercase())
            .map(|e| e.command.clone())
    });
    let result = match found {
        Some(command) => start_run(&app, command, HashMap::new(), source),
        None => Err("Такой команды нет на этом ПК".to_string()),
    };
    if let Err(message) = result {
        emit_run(
            &app,
            json!({"state":"failed","name":name,"message":message,"source":source}),
        );
    }
}

fn start_run(
    app: &tauri::AppHandle,
    command: Command,
    params: HashMap<String, String>,
    source: &'static str,
) -> Result<(), String> {
    let state = app.state::<Desktop>();
    {
        let mut running = state.running.lock().map_err(lock_error)?;
        if running.is_some() {
            return Err("Другая команда ещё выполняется. Дождитесь или нажмите Stop.".into());
        }
        *running = Some(command.name.clone());
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        run(&handle, &command, params, source).await;
        if let Ok(mut running) = handle.state::<Desktop>().running.lock() {
            *running = None;
        }
    });
    Ok(())
}

fn finish(
    app: &tauri::AppHandle,
    run_id: &str,
    command: &Command,
    state: &str,
    message: &str,
    source: &str,
    reply_text: &str,
) {
    emit_run(
        app,
        json!({"run_id":run_id,"name":command.name,"state":state,"message":message,"reply":reply_text,"source":source}),
    );
}

fn describe(result: &Value) -> String {
    match (result["status"].as_str(), result["code"].as_str()) {
        (Some("denied"), Some("session_locked")) => "Сессия заблокирована".into(),
        (Some("denied"), Some("confirmation_expired")) => "Время подтверждения истекло".into(),
        (Some("denied"), _) => result["message"].as_str().map_or_else(
            || "Отклонено пользователем или политикой ПК".into(),
            str::to_string,
        ),
        _ => "Действие не удалось выполнить".into(),
    }
}

enum StepError {
    Timeout,
    Cancelled,
}

impl StepError {
    fn message(&self) -> &'static str {
        match self {
            Self::Timeout => "Время ожидания шага истекло",
            Self::Cancelled => "Остановлено",
        }
    }
}

async fn wait_for(
    rx: tokio::sync::oneshot::Receiver<Value>,
    cancel: &std::sync::atomic::AtomicBool,
    timeout: Duration,
) -> Result<Value, StepError> {
    let mut rx = rx;
    let started = Instant::now();
    loop {
        tokio::select! {
            result = &mut rx => return result.map_err(|_| StepError::Cancelled),
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                if cancel.load(Ordering::SeqCst) {
                    return Err(StepError::Cancelled);
                }
                if started.elapsed() > timeout {
                    return Err(StepError::Timeout);
                }
            }
        }
    }
}

fn dispatch(app: &tauri::AppHandle, call: policy::ToolCall) {
    let state = app.state::<Desktop>();
    let decision = (|| {
        let settings = state.settings.lock().map_err(lock_error)?;
        policy::validate(
            &call,
            &settings.permissions,
            &state.root,
            &settings.device_id,
            commands::LOCAL_SESSION,
            &mut HashMap::new(),
        )
    })();
    match decision {
        Ok(policy::Decision::Safe) => execute_call(app.clone(), call, false),
        Ok(policy::Decision::Confirm) => {
            if !queue_confirm(app, call.clone()) {
                reply(
                    app,
                    &call,
                    json!({"status":"denied","message":"Слишком много открытых подтверждений"}),
                    false,
                );
            }
        }
        Err(reason) => reply(
            app,
            &call,
            json!({"status":"denied","message":reason}),
            false,
        ),
    }
}

async fn step(
    app: &tauri::AppHandle,
    device: &str,
    tool: &str,
    arguments: Value,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<Value, StepError> {
    let call = commands::local_call(device, tool, arguments);
    let call_id = call.call_id.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.state::<Desktop>()
        .waiters
        .lock()
        .map_err(|_| StepError::Cancelled)?
        .insert(call_id.clone(), tx);
    dispatch(app, call);
    let outcome = wait_for(rx, cancel, STEP_TIMEOUT).await;
    if outcome.is_err() {
        // The step is over: drop the waiter and the confirmation card so a late reply cannot land.
        abandon_local_call(app, &call_id);
    }
    outcome
}

fn abandon_local_call(app: &tauri::AppHandle, call_id: &str) {
    let state = app.state::<Desktop>();
    if let Ok(mut waiters) = state.waiters.lock() {
        waiters.remove(call_id);
    }
    if let Ok(mut pending) = state.pending.lock() {
        pending.remove(call_id);
    }
    let _ = app.emit("host-confirm-closed", json!({"call_id": call_id}));
}

async fn run(
    app: &tauri::AppHandle,
    command: &Command,
    params: HashMap<String, String>,
    source: &'static str,
) {
    let state = app.state::<Desktop>();
    let run_id = uuid::Uuid::new_v4().to_string();
    let cancel = match state.cancelled.lock() {
        Ok(c) => c.clone(),
        Err(_) => return,
    };
    let (device, enabled) = match state.settings.lock() {
        Ok(s) => (s.device_id.clone(), s.permissions.enabled),
        Err(_) => return,
    };
    if !enabled {
        finish(
            app,
            &run_id,
            command,
            "failed",
            "Доступ к ПК выключен. Включите его на вкладке «Доступ к ПК».",
            source,
            "",
        );
        return;
    }
    if state.screen_locked.load(Ordering::SeqCst) {
        finish(
            app,
            &run_id,
            command,
            "failed",
            "Сессия заблокирована: команды ПК недоступны",
            source,
            "",
        );
        return;
    }
    let steps = match commands::render(command, &params) {
        Ok(steps) => steps,
        Err(message) => return finish(app, &run_id, command, "failed", &message, source, ""),
    };
    let total = steps.len();
    emit_run(
        app,
        json!({"run_id":run_id,"name":command.name,"state":"started","total":total,"source":source}),
    );
    if command.confirm {
        let summary: Vec<Value> = steps
            .iter()
            .map(|(tool, args)| json!({"tool":tool,"arguments":args}))
            .collect();
        let call = commands::local_call(
            &device,
            CONFIRM_TOOL,
            json!({"name":command.name,"steps":summary}),
        );
        let (tx, rx) = tokio::sync::oneshot::channel();
        if let Ok(mut waiters) = state.waiters.lock() {
            waiters.insert(call.call_id.clone(), tx);
        }
        if !queue_confirm(app, call.clone()) {
            abandon_local_call(app, &call.call_id);
            return finish(
                app,
                &run_id,
                command,
                "failed",
                "Слишком много открытых подтверждений",
                source,
                "",
            );
        }
        match wait_for(rx, &cancel, STEP_TIMEOUT).await {
            Ok(result) if result["status"] == "ok" => {}
            Ok(result) => {
                return finish(
                    app,
                    &run_id,
                    command,
                    "cancelled",
                    &describe(&result),
                    source,
                    "",
                )
            }
            Err(error) => {
                abandon_local_call(app, &call.call_id);
                return finish(
                    app,
                    &run_id,
                    command,
                    if matches!(error, StepError::Timeout) {
                        "failed"
                    } else {
                        "cancelled"
                    },
                    error.message(),
                    source,
                    "",
                );
            }
        }
    }
    let mut problems = 0;
    for (index, (tool, arguments)) in steps.into_iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return finish(
                app,
                &run_id,
                command,
                "cancelled",
                "Остановлено",
                source,
                "",
            );
        }
        emit_run(
            app,
            json!({"run_id":run_id,"name":command.name,"state":"step","step":index + 1,"total":total,"tool":tool,"source":source}),
        );
        match step(app, &device, &tool, arguments, &cancel).await {
            Ok(result) if result["status"] == "ok" => {}
            Ok(result) => {
                problems += 1;
                let message = format!("Шаг {} из {}: {}", index + 1, total, describe(&result));
                if command.on_error == commands::OnError::Stop {
                    return finish(app, &run_id, command, "failed", &message, source, "");
                }
            }
            Err(error) => {
                return finish(
                    app,
                    &run_id,
                    command,
                    if matches!(error, StepError::Timeout) {
                        "failed"
                    } else {
                        "cancelled"
                    },
                    error.message(),
                    source,
                    "",
                )
            }
        }
    }
    logs::log(
        &state.root,
        "info",
        &format!("command finished steps={total} problems={problems}"),
    );
    let say = if problems == 0 {
        command.reply.clone()
    } else {
        String::new()
    };
    if command.speak && !say.is_empty() {
        // Same server TTS as normal answers; offline the text reply is still shown.
        let _ = send(&state.voice, json!({"type":"speak","text":say}));
    }
    let message = if problems == 0 {
        "Готово".to_string()
    } else {
        format!("Выполнено с ошибками: {problems}")
    };
    finish(
        app,
        &run_id,
        command,
        if problems == 0 { "finished" } else { "failed" },
        &message,
        source,
        &say,
    );
}

fn outcome(app: &tauri::AppHandle, state: &Desktop, text: &str) -> Result<Value, String> {
    ensure_loaded(state)?;
    let list = state.commands.lock().map_err(lock_error)?.commands();
    match commands::find_match(&list, text) {
        Match::One(index, params) => {
            let command = list[index].clone();
            let name = command.name.clone();
            start_run(app, command, params, "text")?;
            Ok(json!({"handled":true,"command":name}))
        }
        Match::Ambiguous(names) => Ok(json!({"handled":false,"ambiguous":names})),
        Match::None => Ok(json!({"handled":false})),
    }
}

pub fn try_phrase(
    app: &tauri::AppHandle,
    state: &Desktop,
    text: &str,
) -> Result<Option<Value>, String> {
    let value = outcome(app, state, text)?;
    Ok((value["handled"] == true).then_some(value))
}

pub fn receive_draft(app: &tauri::AppHandle, packet: &Value) {
    let state = app.state::<Desktop>();
    let id = packet["draft_id"]
        .as_str()
        .filter(|id| uuid::Uuid::parse_str(id).is_ok());
    let command = commands::from_draft(&packet["draft"]);
    match (id, command) {
        (Some(id), Ok(command)) => {
            let _ = ensure_loaded(&state);
            let exists = state
                .commands
                .lock()
                .map(|s| {
                    s.entries()
                        .iter()
                        .any(|e| e.command.name.to_lowercase() == command.name.to_lowercase())
                })
                .unwrap_or(false);
            if let Ok(mut drafts) = state.drafts.lock() {
                if drafts.len() >= 8 {
                    drafts.clear();
                }
                drafts.insert(id.to_string(), command.clone());
            }
            let _ = app.emit(
                "command-draft",
                json!({"draft_id":id,"command":command,"exists":exists}),
            );
        }
        (_, Err(reason)) => {
            let _ = app.emit("command-draft-invalid", json!({"reason":reason}));
        }
        _ => {
            let _ = app.emit(
                "command-draft-invalid",
                json!({"reason":"Черновик команды повреждён"}),
            );
        }
    }
}

#[tauri::command]
pub fn commands_list(state: State<'_, Desktop>) -> Result<Value, String> {
    ensure_loaded(&state)?;
    view(&state)
}

#[tauri::command]
pub fn command_save(
    app: tauri::AppHandle,
    state: State<'_, Desktop>,
    file: Option<String>,
    command: Command,
) -> Result<String, String> {
    ensure_writable(&state)?;
    ensure_loaded(&state)?;
    let entries = state
        .commands
        .lock()
        .map_err(lock_error)?
        .entries()
        .to_vec();
    if file.is_none() && entries.len() >= commands::MAX_COMMANDS {
        return Err(format!("Не больше {} команд", commands::MAX_COMMANDS));
    }
    let saved = commands::write_command(&dir(&state), &entries, file.as_deref(), &command, None)?;
    after_change(&app);
    Ok(saved)
}

#[tauri::command]
pub fn command_save_yaml(
    app: tauri::AppHandle,
    state: State<'_, Desktop>,
    file: Option<String>,
    yaml: String,
) -> Result<Value, String> {
    ensure_writable(&state)?;
    ensure_loaded(&state)?;
    if yaml.len() as u64 > commands::MAX_FILE_BYTES {
        return Ok(
            json!({"ok":false,"error":{"line":null,"column":null,"reason":"Файл больше 64 КБ"}}),
        );
    }
    let command = match commands::parse(&yaml) {
        Ok(command) => command,
        Err(f) => {
            return Ok(
                json!({"ok":false,"error":{"line":f.line,"column":f.column,"reason":f.reason}}),
            )
        }
    };
    let entries = state
        .commands
        .lock()
        .map_err(lock_error)?
        .entries()
        .to_vec();
    if file.is_none() && entries.len() >= commands::MAX_COMMANDS {
        return Err(format!("Не больше {} команд", commands::MAX_COMMANDS));
    }
    match commands::write_command(
        &dir(&state),
        &entries,
        file.as_deref(),
        &command,
        Some(&yaml),
    ) {
        Ok(saved) => {
            after_change(&app);
            Ok(json!({"ok":true,"file":saved}))
        }
        Err(reason) => Ok(json!({"ok":false,"error":{"line":null,"column":null,"reason":reason}})),
    }
}

#[tauri::command]
pub fn command_get_yaml(state: State<'_, Desktop>, file: String) -> Result<String, String> {
    let name = commands::safe_file_name(&file)?;
    let bytes = storage::read_limited(&dir(&state).join(name), commands::MAX_FILE_BYTES)?;
    String::from_utf8(bytes).map_err(|_| "Файл должен быть в UTF-8".into())
}

#[tauri::command]
pub fn command_delete(
    app: tauri::AppHandle,
    state: State<'_, Desktop>,
    file: String,
) -> Result<(), String> {
    ensure_writable(&state)?;
    commands::delete_file(&dir(&state), &file)?;
    after_change(&app);
    Ok(())
}

#[tauri::command]
pub fn command_set_enabled(
    app: tauri::AppHandle,
    state: State<'_, Desktop>,
    file: String,
    enabled: bool,
) -> Result<(), String> {
    ensure_writable(&state)?;
    ensure_loaded(&state)?;
    let entries = state
        .commands
        .lock()
        .map_err(lock_error)?
        .entries()
        .to_vec();
    let mut command = entries
        .iter()
        .find(|e| e.file == file)
        .map(|e| e.command.clone())
        .ok_or("Команда не найдена")?;
    command.enabled = enabled;
    commands::write_command(&dir(&state), &entries, Some(&file), &command, None)?;
    after_change(&app);
    Ok(())
}

fn find(state: &Desktop, file: &str) -> Result<Command, String> {
    ensure_loaded(state)?;
    state
        .commands
        .lock()
        .map_err(lock_error)?
        .entries()
        .iter()
        .find(|e| e.file == file)
        .map(|e| e.command.clone())
        .ok_or_else(|| "Команда не найдена".into())
}

#[tauri::command]
pub fn command_dry_run(
    state: State<'_, Desktop>,
    file: String,
    params: Option<HashMap<String, String>>,
) -> Result<Vec<commands::Preview>, String> {
    let command = find(&state, &file)?;
    let settings = state.settings.lock().map_err(lock_error)?;
    commands::dry_run(
        &command,
        &params.unwrap_or_default(),
        &settings.permissions,
        &state.root,
        &settings.device_id,
    )
}

#[tauri::command]
pub fn command_run(
    app: tauri::AppHandle,
    state: State<'_, Desktop>,
    file: String,
    params: Option<HashMap<String, String>>,
) -> Result<(), String> {
    let command = find(&state, &file)?;
    start_run(&app, command, params.unwrap_or_default(), "ui")
}

#[tauri::command]
pub fn command_run_phrase(
    app: tauri::AppHandle,
    state: State<'_, Desktop>,
    text: String,
) -> Result<Value, String> {
    if text.trim().is_empty() || text.chars().count() > 300 {
        return Err("Фраза должна содержать 1–300 символов".into());
    }
    outcome(&app, &state, &text)
}

#[tauri::command]
pub fn draft_confirm(
    app: tauri::AppHandle,
    state: State<'_, Desktop>,
    draft_id: String,
) -> Result<String, String> {
    ensure_writable(&state)?;
    let command = state
        .drafts
        .lock()
        .map_err(lock_error)?
        .remove(&draft_id)
        .ok_or("Черновик устарел")?;
    ensure_loaded(&state)?;
    let entries = state
        .commands
        .lock()
        .map_err(lock_error)?
        .entries()
        .to_vec();
    if entries.len() >= commands::MAX_COMMANDS {
        return Err(format!("Не больше {} команд", commands::MAX_COMMANDS));
    }
    let saved = commands::write_command(&dir(&state), &entries, None, &command, None)?;
    after_change(&app);
    Ok(saved)
}

#[tauri::command]
pub fn draft_reject(state: State<'_, Desktop>, draft_id: String) -> Result<(), String> {
    state.drafts.lock().map_err(lock_error)?.remove(&draft_id);
    Ok(())
}

#[tauri::command]
pub async fn config_export(app: tauri::AppHandle) -> Result<Value, String> {
    let picker = app.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        picker
            .dialog()
            .file()
            .set_file_name("neyra-config.json")
            .add_filter("Конфигурация Neyra", &["json"])
            .blocking_save_file()
    })
    .await
    .map_err(|_| "Ошибка диалога")?;
    let Some(path) = path else {
        return Ok(json!({"cancelled":true}));
    };
    let path = path.into_path().map_err(|_| "Неверный путь")?;
    let state = app.state::<Desktop>();
    ensure_loaded(&state)?;
    let entries = state
        .commands
        .lock()
        .map_err(lock_error)?
        .entries()
        .to_vec();
    let settings = state.settings.lock().map_err(lock_error)?.clone();
    let bundle = commands::export_bundle(&settings, &entries);
    let bytes = serde_json::to_vec_pretty(&bundle).map_err(|_| "Не удалось подготовить файл")?;
    if bytes.len() as u64 > commands::MAX_BUNDLE_BYTES {
        return Err("Конфигурация слишком большая для экспорта".into());
    }
    storage::atomic_write(&path, &bytes)?;
    Ok(
        json!({"cancelled":false,"commands":entries.len(),"file":path.file_name().map(|n| n.to_string_lossy().into_owned())}),
    )
}

#[tauri::command]
pub async fn import_pick(app: tauri::AppHandle) -> Result<Value, String> {
    let picker = app.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        picker
            .dialog()
            .file()
            .add_filter("Конфигурация Neyra", &["json"])
            .blocking_pick_file()
    })
    .await
    .map_err(|_| "Ошибка диалога")?;
    let Some(path) = path else {
        return Ok(json!({"cancelled":true}));
    };
    let path = path.into_path().map_err(|_| "Неверный путь")?;
    let state = app.state::<Desktop>();
    ensure_loaded(&state)?;
    let bytes = storage::read_limited(&path, commands::MAX_BUNDLE_BYTES).map_err(|e| {
        if e == "Файл слишком большой" {
            "Файл больше 1 МБ".to_string()
        } else {
            e
        }
    })?;
    let bundle = commands::parse_bundle(&bytes)?;
    let entries = state
        .commands
        .lock()
        .map_err(lock_error)?
        .entries()
        .to_vec();
    let (items, valid) = commands::plan_import(&bundle, &entries);
    let current = state
        .settings
        .lock()
        .map_err(lock_error)?
        .permissions
        .clone();
    let sanitized = sanitize_permissions(&current, &bundle.permissions);
    let preview = json!({
        "cancelled": false,
        "items": items,
        "settings": bundle.settings,
        "permissions": {
            "allow_web": sanitized.allow_web,
            "system": sanitized.system,
            "web_domains": sanitized.web_domains,
            "apps": sanitized.apps,
        },
    });
    *state.pending_import.lock().map_err(lock_error)? = Some(PendingImport {
        bundle,
        commands: valid,
        created: Instant::now(),
    });
    Ok(preview)
}

/// Imported web and system flags can only stay the same or become narrower (`current && imported`).
/// The master switch is never turned on from a file. Contour 3–4 (shell, files, folders, screen, input)
/// are not imported: they stay exactly as they are on this PC.
/// `apps` and `web_domains` come from the file and can grow: a program is kept only when it exists
/// here and is not a secret, and a domain is kept only when it is a plain host. The import preview
/// lists those paths and domains so the user sees exactly what will be added.
pub fn sanitize_permissions(
    current: &storage::Permissions,
    imported: &storage::Permissions,
) -> storage::Permissions {
    let apps = imported
        .apps
        .iter()
        .filter(|p| {
            std::fs::canonicalize(p)
                .ok()
                .is_some_and(|c| c.is_file() && !policy::secret_path(&c))
        })
        .take(200)
        .cloned()
        .collect();
    let domains = imported
        .web_domains
        .iter()
        .filter(|d| {
            policy::web_url(&format!("https://{d}"))
                .ok()
                .is_some_and(|u| {
                    u.host_str() == Some(d.as_str()) && u.path() == "/" && u.port().is_none()
                })
        })
        .take(50)
        .cloned()
        .collect();
    storage::Permissions {
        enabled: current.enabled,
        apps,
        allow_web: current.allow_web && imported.allow_web,
        web_domains: domains,
        system: current.system && imported.system,
        shell: current.shell,
        files: current.files,
        fs_roots: current.fs_roots.clone(),
        screen: current.screen,
        screen_auto: current.screen_auto,
        input: current.input,
    }
}

#[tauri::command]
pub fn import_apply(
    app: tauri::AppHandle,
    state: State<'_, Desktop>,
    mode: String,
    conflict: String,
    include_permissions: bool,
    include_settings: bool,
) -> Result<Value, String> {
    ensure_writable(&state)?;
    let pending = state
        .pending_import
        .lock()
        .map_err(lock_error)?
        .take()
        .filter(|p| p.created.elapsed() < IMPORT_TTL)
        .ok_or("Предпросмотр устарел: выберите файл ещё раз")?;
    let conflict = match conflict.as_str() {
        "skip" => Conflict::Skip,
        "overwrite" => Conflict::Overwrite,
        "rename" => Conflict::Rename,
        _ => return Err("Неверная политика конфликтов".into()),
    };
    let replace = match mode.as_str() {
        "merge" => false,
        "replace" => true,
        _ => return Err("Неверный режим импорта".into()),
    };
    ensure_loaded(&state)?;
    let entries = state
        .commands
        .lock()
        .map_err(lock_error)?
        .entries()
        .to_vec();
    let backup = state
        .root
        .join("cache")
        .join(format!("commands-backup-{}", policy::now_ms()));
    let report = commands::apply_import(
        &dir(&state),
        &backup,
        &entries,
        pending.commands,
        replace,
        conflict,
    )?;
    if include_permissions || include_settings {
        let mut next = state.settings.lock().map_err(lock_error)?.clone();
        if include_permissions {
            next.permissions = sanitize_permissions(&next.permissions, &pending.bundle.permissions);
        }
        if include_settings {
            next.theme = pending.bundle.settings.theme.clone();
            next.graphics_mode = pending.bundle.settings.graphics_mode.clone();
            next.audit_days = pending.bundle.settings.audit_days;
        }
        apply_settings(&app, &state, next)?;
    }
    after_change(&app);
    logs::log(
        &state.root,
        "info",
        &format!(
            "import added={} replaced={} renamed={} skipped={}",
            report.added, report.replaced, report.renamed, report.skipped
        ),
    );
    Ok(
        json!({"report":report,"backup_made":replace && !entries.is_empty(),"settings":state.settings.lock().map_err(lock_error)?.clone()}),
    )
}

#[tauri::command]
pub fn import_cancel(state: State<'_, Desktop>) -> Result<(), String> {
    *state.pending_import.lock().map_err(lock_error)? = None;
    Ok(())
}

#[tauri::command]
pub async fn choose_data_root(app: tauri::AppHandle) -> Result<Value, String> {
    let picker = app.clone();
    let path =
        tauri::async_runtime::spawn_blocking(move || picker.dialog().file().blocking_pick_folder())
            .await
            .map_err(|_| "Ошибка диалога")?;
    let Some(path) = path else {
        return Ok(json!({"cancelled":true}));
    };
    let chosen = path.into_path().map_err(|_| "Неверный путь")?;
    let state = app.state::<Desktop>();
    let target = chosen.join("Neyra");
    let reused = storage::move_data_root(&state.root, &target)?;
    state.relocated.store(true, Ordering::SeqCst);
    logs::log(
        &state.root,
        "info",
        "data folder changed; restart required; writes blocked",
    );
    Ok(json!({"cancelled":false,"path":target,"restart_required":true,"reused_existing":reused}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imported_permissions_never_turn_the_master_switch_on() {
        let current = storage::Permissions::default();
        let imported = storage::Permissions {
            enabled: true,
            ..Default::default()
        };
        assert!(!sanitize_permissions(&current, &imported).enabled);
        let on = storage::Permissions {
            enabled: true,
            ..Default::default()
        };
        assert!(sanitize_permissions(&on, &storage::Permissions::default()).enabled);
    }
    #[test]
    fn imported_permissions_never_widen_web_system_or_contours() {
        let current = storage::Permissions {
            allow_web: false,
            system: false,
            shell: false,
            files: false,
            screen: false,
            screen_auto: false,
            input: false,
            ..Default::default()
        };
        let imported = storage::Permissions {
            enabled: true,
            allow_web: true,
            system: true,
            shell: true,
            files: true,
            fs_roots: vec!["/tmp".into()],
            screen: true,
            screen_auto: true,
            input: true,
            ..Default::default()
        };
        let out = sanitize_permissions(&current, &imported);
        assert!(!out.enabled && !out.allow_web && !out.system);
        assert!(!out.shell && !out.files && out.fs_roots.is_empty());
        assert!(!out.screen && !out.screen_auto && !out.input);
        let open = storage::Permissions {
            allow_web: true,
            system: true,
            ..Default::default()
        };
        let narrowed = sanitize_permissions(
            &open,
            &storage::Permissions {
                allow_web: false,
                system: false,
                ..Default::default()
            },
        );
        assert!(!narrowed.allow_web && !narrowed.system);
    }
    #[test]
    fn imported_apps_and_domains_are_filtered_for_this_pc() {
        let real = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let imported = storage::Permissions {
            enabled: false,
            apps: vec![
                real.clone(),
                "/definitely/missing/app".into(),
                "/home/me/.ssh/id_rsa".into(),
            ],
            allow_web: false,
            web_domains: vec![
                "example.com".into(),
                "evil.example/path".into(),
                "user@host.com".into(),
                "host.com:8080".into(),
            ],
            system: false,
            ..Default::default()
        };
        let current = storage::Permissions::default();
        assert!(current.apps.is_empty() && current.web_domains.is_empty());
        let out = sanitize_permissions(&current, &imported);
        // These two fields may grow beyond what this PC already allows.
        assert_eq!(out.apps, vec![real]);
        assert_eq!(out.web_domains, vec!["example.com".to_string()]);
        assert!(!out.allow_web && !out.system);
    }
    #[tokio::test]
    async fn step_timeout_is_its_own_error() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let err = wait_for(rx, &cancel, Duration::from_millis(150))
            .await
            .unwrap_err();
        assert!(matches!(err, StepError::Timeout));
        assert_eq!(err.message(), "Время ожидания шага истекло");
        drop(tx);
        let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
        let cancel = std::sync::atomic::AtomicBool::new(true);
        let err = wait_for(rx, &cancel, Duration::from_secs(30))
            .await
            .unwrap_err();
        assert!(matches!(err, StepError::Cancelled));
        assert_eq!(err.message(), "Остановлено");
        drop(tx);
    }
    #[test]
    fn failure_messages_are_specific() {
        assert!(
            describe(&json!({"status":"denied","message":"Доступ к ПК выключен"}))
                .contains("выключен")
        );
        assert!(
            describe(&json!({"status":"denied","code":"confirmation_expired"}))
                .contains("подтверждения")
        );
        assert!(describe(&json!({"status":"error"})).contains("не удалось"));
    }
}
