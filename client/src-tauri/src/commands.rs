//! User quick commands (PLAN §3b.5). One YAML file per command in `Documents/Neyra/commands/`.
//! Commands only describe fixed `client.*` tool calls. They never bypass the local PC policy.

use crate::{
    policy::{self, ToolCall},
    storage::{atomic_write, read_limited, Permissions},
};
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
    time::UNIX_EPOCH,
};

pub const VERSION: u32 = 1;
pub const LOCAL_SESSION: &str = "local-command";
pub const MAX_COMMANDS: usize = 200;
pub const MAX_FILE_BYTES: u64 = 64 * 1024;
pub const MAX_BUNDLE_BYTES: u64 = 1024 * 1024;
const MAX_TRIGGERS: usize = 4;
const MAX_ACTIONS: usize = 10;
const MAX_PARAMS: usize = 4;
const MANIFEST_BUDGET: usize = 16_000;

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug, Default)]
#[serde(deny_unknown_fields)]
pub struct Trigger {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phrase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub regex: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hotkey: Option<String>,
}
impl Trigger {
    pub fn kind(&self) -> Result<(&'static str, &str), String> {
        match (&self.phrase, &self.regex, &self.hotkey) {
            (Some(v), None, None) => Ok(("phrase", v)),
            (None, Some(v), None) => Ok(("regex", v)),
            (None, None, Some(v)) => Ok(("hotkey", v)),
            _ => Err("Триггер должен содержать ровно одно из: phrase, regex, hotkey".into()),
        }
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
pub struct Param {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
pub struct Action {
    pub tool: String,
    #[serde(default = "empty_object")]
    pub arguments: Value,
}

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum OnError {
    #[default]
    Stop,
    Continue,
}
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    #[default]
    Safe,
    Confirm,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
pub struct Command {
    #[serde(default = "version")]
    pub schema_version: u32,
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    pub triggers: Vec<Trigger>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub params: Vec<Param>,
    pub actions: Vec<Action>,
    #[serde(default)]
    pub on_error: OnError,
    #[serde(default)]
    pub confirm: bool,
    #[serde(default)]
    pub risk: Risk,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reply: String,
    #[serde(default)]
    pub speak: bool,
}

fn empty_object() -> Value {
    json!({})
}
fn version() -> u32 {
    VERSION
}
fn yes() -> bool {
    true
}

/// Lowercase, ё→е, no punctuation, single spaces, no leading wake name. Must match the server rules.
pub fn normalize(text: &str) -> String {
    let cleaned: String = text
        .to_lowercase()
        .replace('ё', "е")
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '_' {
                c
            } else {
                ' '
            }
        })
        .collect();
    let value = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    for prefix in ["нейра ", "neyra "] {
        if let Some(rest) = value.strip_prefix(prefix) {
            return rest.to_string();
        }
    }
    value
}

fn strip_wake_raw(text: &str) -> String {
    let trimmed = text.trim();
    for word in ["нейра", "neyra"] {
        let count = word.chars().count();
        let head: String = trimmed
            .chars()
            .take(count)
            .collect::<String>()
            .to_lowercase();
        if head == word {
            let rest: String = trimmed.chars().skip(count).collect();
            if rest.is_empty() {
                return trimmed.to_string();
            }
            if rest.starts_with(|c: char| c.is_alphanumeric() || c == '_') {
                return trimmed.to_string();
            }
            return rest
                .trim_start_matches(|c: char| !c.is_alphanumeric())
                .to_string();
        }
    }
    trimmed.to_string()
}

pub fn canonical_hotkey(value: &str) -> Result<String, String> {
    let (mut ctrl, mut alt, mut shift, mut sup) = (false, false, false, false);
    let mut key = None;
    for part in value.split('+').map(str::trim) {
        match part.to_lowercase().as_str() {
            "ctrl" | "control" => ctrl = true,
            "alt" | "option" => alt = true,
            "shift" => shift = true,
            "super" | "meta" | "win" | "cmd" | "command" => sup = true,
            other => {
                let ok = (other.len() == 1 && other.chars().all(|c| c.is_ascii_alphanumeric()))
                    || (other.starts_with('f')
                        && other[1..]
                            .parse::<u8>()
                            .is_ok_and(|n| (1..=12).contains(&n)));
                if !ok || key.replace(other.to_uppercase()).is_some() {
                    return Err("Хоткей: одна клавиша A–Z, 0–9 или F1–F12 и модификаторы Ctrl/Alt/Shift/Super".into());
                }
            }
        }
    }
    let key = key.ok_or("Хоткей: не указана клавиша")?;
    if !(ctrl || alt || sup) {
        return Err("Хоткей должен включать Ctrl, Alt или Super".into());
    }
    let mut out = Vec::new();
    for (on, name) in [
        (ctrl, "Ctrl"),
        (alt, "Alt"),
        (shift, "Shift"),
        (sup, "Super"),
    ] {
        if on {
            out.push(name.to_string());
        }
    }
    out.push(key);
    Ok(out.join("+"))
}

fn valid_param_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && name.len() <= 24
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn placeholders(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if let Some(end) = text[i + 1..].find('}') {
                let name = &text[i + 1..i + 1 + end];
                if valid_param_name(name) {
                    found.push(name.to_string());
                    i += end + 2;
                    continue;
                }
            }
        }
        i += 1;
    }
    found
}

fn clean_text(value: &str, max: usize, what: &str) -> Result<(), String> {
    if value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(format!(
            "{what}: до {max} символов, без управляющих символов"
        ));
    }
    Ok(())
}

pub fn min_risk(command: &Command) -> Risk {
    if command
        .actions
        .iter()
        .any(|a| a.tool == "client.close_window")
    {
        Risk::Confirm
    } else {
        Risk::Safe
    }
}

pub fn validate(command: &Command) -> Result<(), String> {
    if command.schema_version != VERSION {
        return Err(format!(
            "Версия схемы {} не поддерживается этой версией приложения (нужна {VERSION})",
            command.schema_version
        ));
    }
    let name = command.name.trim();
    if name.is_empty() {
        return Err("Укажите имя команды".into());
    }
    clean_text(&command.name, 60, "Имя")?;
    clean_text(&command.description, 200, "Описание")?;
    clean_text(&command.reply, 200, "Ответ")?;
    if command.triggers.is_empty() || command.triggers.len() > MAX_TRIGGERS {
        return Err(format!("Нужно от 1 до {MAX_TRIGGERS} триггеров"));
    }
    if command.params.len() > MAX_PARAMS {
        return Err(format!("Не больше {MAX_PARAMS} параметров"));
    }
    let mut declared = HashSet::new();
    for param in &command.params {
        if !valid_param_name(&param.name) || !declared.insert(param.name.clone()) {
            return Err(format!(
                "Параметр «{}»: латиница a–z, цифры и _, уникальное имя до 24 символов",
                param.name
            ));
        }
        if let Some(default) = &param.default {
            clean_text(default, 200, "Значение по умолчанию")?;
        }
        clean_text(&param.description, 120, "Описание параметра")?;
    }
    for trigger in &command.triggers {
        match trigger.kind()? {
            ("phrase", value) => {
                clean_text(value, 120, "Фраза")?;
                if normalize(value).chars().count() < 2 {
                    return Err("Фраза слишком короткая".into());
                }
            }
            ("regex", value) => {
                if value.chars().count() > 120 {
                    return Err("Регулярное выражение: до 120 символов".into());
                }
                let re = RegexBuilder::new(&format!("^(?:{value})$"))
                    .case_insensitive(true)
                    .size_limit(200_000)
                    .build()
                    .map_err(|_| "Некорректное регулярное выражение")?;
                for group in re.capture_names().flatten() {
                    if !declared.contains(group) {
                        return Err(format!("Группа «{group}» не объявлена в params"));
                    }
                }
            }
            (_, value) => {
                canonical_hotkey(value)?;
            }
        }
    }
    if command.actions.is_empty() || command.actions.len() > MAX_ACTIONS {
        return Err(format!("Нужно от 1 до {MAX_ACTIONS} действий"));
    }
    for (index, action) in command.actions.iter().enumerate() {
        let step = index + 1;
        let keys = policy::tool_keys(&action.tool)
            .ok_or_else(|| format!("Действие {step}: инструмент «{}» недоступен", action.tool))?;
        let object = action
            .arguments
            .as_object()
            .ok_or_else(|| format!("Действие {step}: arguments должны быть объектом"))?;
        if object.len() != keys.len() || object.keys().any(|k| !keys.contains(&k.as_str())) {
            return Err(format!(
                "Действие {step}: нужны параметры {}",
                if keys.is_empty() {
                    "без аргументов".into()
                } else {
                    keys.join(", ")
                }
            ));
        }
        for value in object.values() {
            let text = value
                .as_str()
                .ok_or_else(|| format!("Действие {step}: значения должны быть строками"))?;
            clean_text(text, 500, "Значение действия")?;
            for name in placeholders(text) {
                if !declared.contains(&name) {
                    return Err(format!(
                        "Действие {step}: параметр {{{name}}} не объявлен в params"
                    ));
                }
            }
        }
    }
    if min_risk(command) == Risk::Confirm && command.risk == Risk::Safe {
        return Err("Команда закрывает окна: укажите risk: confirm".into());
    }
    Ok(())
}

pub struct Failure {
    pub line: Option<usize>,
    pub column: Option<usize>,
    pub reason: String,
}

fn explain(message: &str) -> String {
    let message = message.split(" at line ").next().unwrap_or(message);
    for (marker, text) in [
        ("missing field `", "Нет обязательного поля"),
        ("unknown field `", "Неизвестное поле"),
    ] {
        if let Some(rest) = message.strip_prefix(marker) {
            return format!("{text} «{}»", rest.split('`').next().unwrap_or(""));
        }
    }
    format!("Ошибка YAML: {message}")
}

pub fn parse(text: &str) -> Result<Command, Failure> {
    let command: Command = serde_yaml::from_str(text).map_err(|e| Failure {
        line: e.location().map(|l| l.line()),
        column: e.location().map(|l| l.column()),
        reason: explain(&e.to_string()),
    })?;
    validate(&command).map_err(|reason| Failure {
        line: None,
        column: None,
        reason,
    })?;
    Ok(command)
}

pub fn to_yaml(command: &Command) -> Result<String, String> {
    serde_yaml::to_string(command).map_err(|_| "Не удалось сохранить команду".into())
}

#[derive(Debug, PartialEq)]
pub enum Match {
    None,
    One(usize, HashMap<String, String>),
    Ambiguous(Vec<String>),
}

pub fn find_match(commands: &[Command], text: &str) -> Match {
    let wanted = normalize(text);
    let raw = strip_wake_raw(text);
    if wanted.is_empty() {
        return Match::None;
    }
    let mut hits: Vec<(usize, HashMap<String, String>)> = Vec::new();
    for (index, command) in commands.iter().enumerate() {
        if !command.enabled {
            continue;
        }
        for trigger in &command.triggers {
            let captures = match trigger.kind() {
                Ok(("phrase", value)) if normalize(value) == wanted => Some(HashMap::new()),
                Ok(("regex", value)) => RegexBuilder::new(&format!("^(?:{value})$"))
                    .case_insensitive(true)
                    .size_limit(200_000)
                    .build()
                    .ok()
                    .and_then(|re| {
                        re.captures(&raw).map(|c| {
                            re.capture_names()
                                .flatten()
                                .filter_map(|n| {
                                    c.name(n)
                                        .map(|m| (n.to_string(), m.as_str().trim().to_string()))
                                })
                                .collect()
                        })
                    }),
                _ => None,
            };
            if let Some(found) = captures {
                if !hits.iter().any(|(i, _)| *i == index) {
                    hits.push((index, found));
                }
                break;
            }
        }
    }
    match hits.len() {
        0 => Match::None,
        1 => {
            let (index, params) = hits.remove(0);
            Match::One(index, params)
        }
        _ => Match::Ambiguous(
            hits.iter()
                .map(|(i, _)| commands[*i].name.clone())
                .collect(),
        ),
    }
}

/// Fixed arguments with `{param}` filled in. The final values still go through the normal PC policy.
pub fn render(
    command: &Command,
    given: &HashMap<String, String>,
) -> Result<Vec<(String, Value)>, String> {
    let mut values = HashMap::new();
    for param in &command.params {
        let value = given
            .get(&param.name)
            .cloned()
            .or_else(|| param.default.clone())
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| format!("Не задан параметр «{}»", param.name))?;
        clean_text(&value, 200, "Значение параметра")?;
        values.insert(param.name.clone(), value);
    }
    command
        .actions
        .iter()
        .map(|action| {
            let mut arguments = serde_json::Map::new();
            for (key, value) in action.arguments.as_object().into_iter().flatten() {
                let mut text = value.as_str().unwrap_or_default().to_string();
                for name in placeholders(&text) {
                    text = text.replace(
                        &format!("{{{name}}}"),
                        values.get(&name).map(String::as_str).unwrap_or(""),
                    );
                }
                arguments.insert(key.clone(), Value::String(text));
            }
            Ok((action.tool.clone(), Value::Object(arguments)))
        })
        .collect()
}

pub fn local_call(device: &str, tool: &str, arguments: Value) -> ToolCall {
    ToolCall {
        call_id: uuid::Uuid::new_v4().to_string(),
        device_id: device.to_string(),
        session_id: LOCAL_SESSION.into(),
        tool: tool.to_string(),
        arguments,
        deadline_ms: policy::now_ms() + 30_000,
    }
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Preview {
    pub step: usize,
    pub tool: String,
    pub verdict: &'static str,
    pub message: String,
}

pub fn dry_run(
    command: &Command,
    given: &HashMap<String, String>,
    permissions: &Permissions,
    device: &str,
) -> Result<Vec<Preview>, String> {
    let advertised = policy::capabilities(permissions);
    render(command, given)?
        .into_iter()
        .enumerate()
        .map(|(index, (tool, arguments))| {
            let step = index + 1;
            if !permissions.enabled {
                return Ok(Preview {
                    step,
                    tool,
                    verdict: "denied",
                    message: "Доступ к ПК выключен".into(),
                });
            }
            if !advertised.contains(&tool) {
                return Ok(Preview {
                    step,
                    tool,
                    verdict: "unavailable",
                    message: "Инструмент выключен или недоступен на этой ОС".into(),
                });
            }
            let call = local_call(device, &tool, arguments);
            let (verdict, message) = match policy::validate(
                &call,
                permissions,
                device,
                LOCAL_SESSION,
                &mut HashMap::new(),
            ) {
                Ok(policy::Decision::Safe) => ("safe", "Выполнится без вопросов".to_string()),
                Ok(policy::Decision::Confirm) => {
                    ("confirm", "Потребуется карточка подтверждения".to_string())
                }
                Err(reason) => ("denied", reason),
            };
            Ok(Preview {
                step,
                tool,
                verdict,
                message,
            })
        })
        .collect()
}

#[derive(Clone, Serialize, Debug, PartialEq)]
pub struct LoadError {
    pub file: String,
    pub line: Option<usize>,
    pub column: Option<usize>,
    pub reason: String,
    pub kept_previous: bool,
}

#[derive(Clone, Serialize, Debug, PartialEq)]
pub struct Entry {
    pub file: String,
    pub command: Command,
}

type Stamp = Vec<(String, u64, u64)>;

#[derive(Default)]
pub struct Store {
    entries: Vec<Entry>,
    errors: Vec<LoadError>,
    good: HashMap<String, Command>,
    stamp: Stamp,
    loaded: bool,
}

impl Store {
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }
    pub fn errors(&self) -> &[LoadError] {
        &self.errors
    }
    pub fn commands(&self) -> Vec<Command> {
        self.entries.iter().map(|e| e.command.clone()).collect()
    }

    pub fn dirty(&self, dir: &Path) -> bool {
        !self.loaded || fingerprint(dir) != self.stamp
    }

    /// Returns true when the visible result (active commands or errors) changed.
    pub fn reload(&mut self, dir: &Path) -> bool {
        let stamp = fingerprint(dir);
        let (old_entries, old_errors) = (self.entries.clone(), self.errors.clone());
        let mut files: Vec<String> = stamp.iter().map(|s| s.0.clone()).collect();
        files.sort();
        let mut entries = Vec::new();
        let mut errors = Vec::new();
        let mut names: HashMap<String, String> = HashMap::new();
        let mut hotkeys: HashMap<String, String> = HashMap::new();
        let mut present = HashSet::new();
        for file in files {
            present.insert(file.clone());
            let fail = |errors: &mut Vec<LoadError>, line, column, reason: String, kept| {
                errors.push(LoadError {
                    file: file.clone(),
                    line,
                    column,
                    reason,
                    kept_previous: kept,
                });
            };
            let path = dir.join(&file);
            let meta = fs::symlink_metadata(&path);
            if !meta.as_ref().is_ok_and(|m| m.is_file()) {
                fail(
                    &mut errors,
                    None,
                    None,
                    "Символические ссылки и особые файлы не поддерживаются".into(),
                    false,
                );
                continue;
            }
            let parsed = read_limited(&path, MAX_FILE_BYTES)
                .map_err(|e| Failure {
                    line: None,
                    column: None,
                    reason: if e == "Файл слишком большой" {
                        "Файл больше 64 КБ".into()
                    } else {
                        "Файл недоступен".into()
                    },
                })
                .and_then(|bytes| {
                    String::from_utf8(bytes).map_err(|_| Failure {
                        line: None,
                        column: None,
                        reason: "Файл должен быть в UTF-8".into(),
                    })
                })
                .and_then(|text| parse(&text));
            let command = match parsed {
                Ok(command) => command,
                Err(f) => {
                    let kept = self.good.get(&file).cloned();
                    fail(&mut errors, f.line, f.column, f.reason, kept.is_some());
                    match kept {
                        Some(previous) => previous,
                        None => continue,
                    }
                }
            };
            if entries.len() >= MAX_COMMANDS {
                fail(
                    &mut errors,
                    None,
                    None,
                    format!("Больше {MAX_COMMANDS} команд: файл пропущен"),
                    false,
                );
                continue;
            }
            if let Some(owner) = names.get(&command.name.to_lowercase()) {
                fail(
                    &mut errors,
                    None,
                    None,
                    format!("Имя «{}» уже занято файлом {owner}", command.name),
                    false,
                );
                continue;
            }
            let conflict = command
                .triggers
                .iter()
                .filter_map(|t| t.hotkey.as_deref())
                .filter_map(|h| canonical_hotkey(h).ok())
                .find(|h| hotkeys.contains_key(h));
            if let Some(hotkey) = conflict {
                let owner = hotkeys[&hotkey].clone();
                fail(
                    &mut errors,
                    None,
                    None,
                    format!("Хоткей {hotkey} уже занят файлом {owner}"),
                    false,
                );
                continue;
            }
            for trigger in &command.triggers {
                if let Some(h) = trigger
                    .hotkey
                    .as_deref()
                    .and_then(|h| canonical_hotkey(h).ok())
                {
                    hotkeys.insert(h, file.clone());
                }
            }
            names.insert(command.name.to_lowercase(), file.clone());
            self.good.insert(file.clone(), command.clone());
            entries.push(Entry {
                file: file.clone(),
                command,
            });
        }
        self.good.retain(|file, _| present.contains(file));
        self.entries = entries;
        self.errors = errors;
        self.stamp = stamp;
        self.loaded = true;
        old_entries != self.entries || old_errors != self.errors
    }
}

fn fingerprint(dir: &Path) -> Stamp {
    let mut stamp = Vec::new();
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let lower = name.to_lowercase();
        if name.starts_with('.') || !(lower.ends_with(".yaml") || lower.ends_with(".yml")) {
            continue;
        }
        let meta = fs::symlink_metadata(entry.path()).ok();
        let modified = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        stamp.push((name, meta.map(|m| m.len()).unwrap_or(0), modified));
    }
    stamp.sort();
    stamp
}

pub fn safe_file_name(file: &str) -> Result<&str, String> {
    let lower = file.to_lowercase();
    let ok = !file.is_empty()
        && file.len() <= 96
        && !file.starts_with('.')
        && (lower.ends_with(".yaml") || lower.ends_with(".yml"))
        && !file.contains(['/', '\\', '\0', ':'])
        && file != "."
        && file != "..";
    if ok {
        Ok(file)
    } else {
        Err("Неверное имя файла команды".into())
    }
}

pub fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed: String = out.trim_matches('-').chars().take(48).collect();
    let trimmed = trimmed.trim_matches('-').to_string();
    let reserved = [
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "lpt1", "lpt2", "lpt3",
    ];
    if trimmed.is_empty() {
        "command".into()
    } else if reserved.contains(&trimmed.as_str()) {
        format!("cmd-{trimmed}")
    } else {
        trimmed
    }
}

fn hotkeys_of(command: &Command) -> Vec<String> {
    command
        .triggers
        .iter()
        .filter_map(|t| t.hotkey.as_deref())
        .filter_map(|h| canonical_hotkey(h).ok())
        .collect()
}

fn check_unique(
    entries: &[Entry],
    existing: Option<&str>,
    command: &Command,
) -> Result<(), String> {
    for other in entries.iter().filter(|e| Some(e.file.as_str()) != existing) {
        if other.command.name.to_lowercase() == command.name.trim().to_lowercase() {
            return Err("Команда с таким именем уже есть".into());
        }
        let mine = hotkeys_of(command);
        if let Some(h) = hotkeys_of(&other.command)
            .into_iter()
            .find(|h| mine.contains(h))
        {
            return Err(format!(
                "Хоткей {h} уже занят командой «{}»",
                other.command.name
            ));
        }
    }
    Ok(())
}

/// Writes one command file atomically. `raw` keeps the user's own YAML (comments) when it was already validated.
pub fn write_command(
    dir: &Path,
    entries: &[Entry],
    existing: Option<&str>,
    command: &Command,
    raw: Option<&str>,
) -> Result<String, String> {
    let mut command = command.clone();
    command.name = command.name.trim().to_string();
    validate(&command)?;
    check_unique(entries, existing, &command)?;
    let file = match existing {
        Some(file) => safe_file_name(file)?.to_string(),
        None => {
            let base = slug(&command.name);
            let mut candidate = format!("{base}.yaml");
            let mut n = 2;
            while dir.join(&candidate).exists() {
                candidate = format!("{base}-{n}.yaml");
                n += 1;
                if n > 200 {
                    return Err("Слишком много файлов с похожим именем".into());
                }
            }
            candidate
        }
    };
    let text = match raw {
        Some(raw) => raw.to_string(),
        None => to_yaml(&command)?,
    };
    atomic_write(&dir.join(&file), text.as_bytes())?;
    Ok(file)
}

pub fn delete_file(dir: &Path, file: &str) -> Result<(), String> {
    let file = safe_file_name(file)?;
    let path = dir.join(file);
    if !fs::symlink_metadata(&path).is_ok_and(|m| m.is_file()) {
        return Err("Файл команды не найден".into());
    }
    fs::remove_file(path).map_err(|_| "Не удалось удалить файл команды".into())
}

/// Server drafts ("запомни команду…") become ordinary commands only after the user confirms locally.
pub fn from_draft(value: &Value) -> Result<Command, String> {
    let object = value.as_object().ok_or("Черновик повреждён")?;
    let text = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let phrases = object
        .get("phrases")
        .and_then(Value::as_array)
        .ok_or("В черновике нет фраз")?;
    let actions = object
        .get("actions")
        .and_then(Value::as_array)
        .ok_or("В черновике нет действий")?;
    let mut command = Command {
        schema_version: VERSION,
        name: text("name").trim().to_string(),
        description: "Создана голосом или в чате".into(),
        enabled: true,
        triggers: phrases
            .iter()
            .map(|p| Trigger {
                phrase: Some(p.as_str().unwrap_or("").trim().to_string()),
                ..Default::default()
            })
            .collect(),
        params: vec![],
        actions: actions
            .iter()
            .map(|a| Action {
                tool: a["tool"].as_str().unwrap_or("").to_string(),
                arguments: a.get("arguments").cloned().unwrap_or_else(empty_object),
            })
            .collect(),
        on_error: OnError::Stop,
        confirm: false,
        risk: Risk::Safe,
        reply: text("reply"),
        speak: false,
    };
    command.risk = min_risk(&command);
    validate(&command)?;
    Ok(command)
}

/// Only names, trigger texts and tool names. No arguments, paths or secrets leave this PC. Regexes stay local.
pub fn manifest_info(entries: &[Entry]) -> Vec<Value> {
    let mut out = Vec::new();
    let mut size = 0;
    for entry in entries.iter().filter(|e| e.command.enabled).take(32) {
        let triggers: Vec<Value> = entry
            .command
            .triggers
            .iter()
            .filter_map(|t| match t.kind() {
                Ok(("phrase", v)) => Some(json!({"kind":"phrase","value":v})),
                Ok(("hotkey", v)) => canonical_hotkey(v)
                    .ok()
                    .map(|h| json!({"kind":"hotkey","value":h})),
                _ => None,
            })
            .collect();
        let item = json!({
            "name": entry.command.name,
            "triggers": triggers,
            "actions": entry.command.actions.iter().map(|a| a.tool.clone()).collect::<Vec<_>>()
        });
        size += item.to_string().len();
        if size > MANIFEST_BUDGET {
            break;
        }
        out.push(item);
    }
    out
}

pub const BUNDLE_FORMAT: &str = "neyra.config.v1";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct BundleSettings {
    pub theme: String,
    pub graphics_mode: String,
    pub audit_days: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Bundle {
    pub format: String,
    pub exported_at_ms: u64,
    pub settings: BundleSettings,
    pub permissions: Permissions,
    pub commands: Vec<Value>,
}

/// Settings, permissions and commands only. No device id, server profiles, tokens or audit.
pub fn export_bundle(settings: &crate::storage::Settings, entries: &[Entry]) -> Bundle {
    Bundle {
        format: BUNDLE_FORMAT.into(),
        exported_at_ms: policy::now_ms(),
        settings: BundleSettings {
            theme: settings.theme.clone(),
            graphics_mode: settings.graphics_mode.clone(),
            audit_days: settings.audit_days,
        },
        permissions: settings.permissions.clone(),
        commands: entries
            .iter()
            .map(|e| serde_json::to_value(&e.command).unwrap_or(Value::Null))
            .collect(),
    }
}

pub fn parse_bundle(bytes: &[u8]) -> Result<Bundle, String> {
    if bytes.len() as u64 > MAX_BUNDLE_BYTES {
        return Err("Файл больше 1 МБ".into());
    }
    let bundle: Bundle =
        serde_json::from_slice(bytes).map_err(|_| "Это не файл конфигурации Neyra")?;
    if bundle.format != BUNDLE_FORMAT {
        return Err("Неизвестный формат файла конфигурации".into());
    }
    if bundle.commands.len() > MAX_COMMANDS {
        return Err(format!("В файле больше {MAX_COMMANDS} команд"));
    }
    Ok(bundle)
}

#[derive(Serialize, Debug, PartialEq)]
pub struct PlanItem {
    pub name: String,
    pub status: &'static str,
    pub error: Option<String>,
}

pub fn plan_import(bundle: &Bundle, existing: &[Entry]) -> (Vec<PlanItem>, Vec<Command>) {
    let mut items = Vec::new();
    let mut valid = Vec::new();
    let mut seen = HashSet::new();
    for raw in &bundle.commands {
        let name = raw["name"]
            .as_str()
            .unwrap_or("(без имени)")
            .chars()
            .take(60)
            .collect::<String>();
        let command = serde_json::from_value::<Command>(raw.clone())
            .map_err(|e| explain(&e.to_string()))
            .and_then(|c| validate(&c).map(|_| c));
        match command {
            Err(error) => items.push(PlanItem {
                name,
                status: "invalid",
                error: Some(error),
            }),
            Ok(command) => {
                let lower = command.name.trim().to_lowercase();
                if !seen.insert(lower.clone()) {
                    items.push(PlanItem {
                        name,
                        status: "invalid",
                        error: Some("Имя повторяется в файле".into()),
                    });
                    continue;
                }
                let status = match existing
                    .iter()
                    .find(|e| e.command.name.to_lowercase() == lower)
                {
                    Some(e) if e.command == command => "same",
                    Some(_) => "conflict",
                    None => "new",
                };
                items.push(PlanItem {
                    name,
                    status,
                    error: None,
                });
                valid.push(command);
            }
        }
    }
    (items, valid)
}

#[derive(Serialize, Default, Debug, PartialEq)]
pub struct ImportReport {
    pub added: usize,
    pub replaced: usize,
    pub renamed: usize,
    pub skipped: usize,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Conflict {
    Skip,
    Overwrite,
    Rename,
}

/// `replace` first moves every current command file into a backup folder, so it can be undone by hand.
pub fn apply_import(
    dir: &Path,
    backup_dir: &Path,
    existing: &[Entry],
    commands: Vec<Command>,
    replace: bool,
    conflict: Conflict,
) -> Result<ImportReport, String> {
    let mut report = ImportReport::default();
    let mut current: Vec<Entry> = existing.to_vec();
    if replace && !current.is_empty() {
        fs::create_dir_all(backup_dir).map_err(|_| "Не удалось создать резервную копию")?;
        for entry in &current {
            let file = safe_file_name(&entry.file)?;
            fs::rename(dir.join(file), backup_dir.join(file))
                .map_err(|_| "Не удалось сохранить резервную копию")?;
        }
        current.clear();
    }
    for mut command in commands {
        let lower = command.name.trim().to_lowercase();
        let same = current
            .iter()
            .position(|e| e.command.name.to_lowercase() == lower);
        let mut target = None;
        if let Some(index) = same {
            match conflict {
                Conflict::Skip => {
                    report.skipped += 1;
                    continue;
                }
                Conflict::Overwrite => target = Some(current[index].file.clone()),
                Conflict::Rename => {
                    let base = command.name.trim().to_string();
                    let mut n = 2;
                    loop {
                        let candidate = format!(
                            "{base} (импорт{})",
                            if n == 2 {
                                String::new()
                            } else {
                                format!(" {n}")
                            }
                        );
                        let taken = current
                            .iter()
                            .any(|e| e.command.name.to_lowercase() == candidate.to_lowercase());
                        if !taken && candidate.chars().count() <= 60 {
                            command.name = candidate;
                            break;
                        }
                        n += 1;
                        if n > 50 {
                            return Err("Не удалось подобрать имя для импорта".into());
                        }
                    }
                    report.renamed += 1;
                }
            }
        }
        // A foreign hotkey must not silently take over one that is already in use.
        let others: Vec<String> = current
            .iter()
            .filter(|e| Some(&e.file) != target.as_ref())
            .flat_map(|e| hotkeys_of(&e.command))
            .collect();
        command.triggers.retain(|t| {
            t.hotkey
                .as_deref()
                .and_then(|h| canonical_hotkey(h).ok())
                .is_none_or(|h| !others.contains(&h))
        });
        if command.triggers.is_empty() {
            report.skipped += 1;
            continue;
        }
        let file = write_command(dir, &current, target.as_deref(), &command, None)?;
        current.retain(|e| e.file != file);
        current.push(Entry { file, command });
        if same.is_some() && conflict == Conflict::Overwrite {
            report.replaced += 1;
        } else if same.is_none() {
            report.added += 1;
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp() -> std::path::PathBuf {
        let p = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&p).unwrap();
        p
    }
    const GAME: &str = "name: Режим игры\ntriggers:\n  - phrase: режим игры\n  - hotkey: ctrl+alt+g\nactions:\n  - tool: client.open_app\n    arguments:\n      path: /usr/bin/steam\n  - tool: client.media\n    arguments:\n      action: play_pause\nreply: Запускаю\n";
    fn game() -> Command {
        parse(GAME).map_err(|f| f.reason).unwrap()
    }
    fn simple(name: &str, phrase: &str) -> Command {
        let mut c = game();
        c.name = name.into();
        c.triggers = vec![Trigger {
            phrase: Some(phrase.into()),
            ..Default::default()
        }];
        c
    }

    #[test]
    fn yaml_round_trips_with_defaults_and_version() {
        let c = game();
        assert_eq!(
            (c.schema_version, c.enabled, c.on_error, c.risk, c.confirm),
            (1, true, OnError::Stop, Risk::Safe, false)
        );
        let again = parse(&to_yaml(&c).unwrap()).map_err(|f| f.reason).unwrap();
        assert_eq!(c, again);
    }
    #[test]
    fn errors_report_line_and_reason_in_russian() {
        let f = parse("name: x\ntriggers: [\n").err().unwrap();
        assert!(f.line.is_some() && f.reason.starts_with("Ошибка YAML"));
        let f = parse("name: x\ntriggers:\n  - phrase: привет\n")
            .err()
            .unwrap();
        assert!(f.reason.contains("actions"), "{}", f.reason);
        let f = parse("name: x\nbogus: 1\ntriggers: []\nactions: []\n")
            .err()
            .unwrap();
        assert!(f.reason.contains("bogus"));
    }
    #[test]
    fn newer_schema_is_rejected_not_guessed() {
        let f = parse(&GAME.replace("name:", "schema_version: 9\nname:"))
            .err()
            .unwrap();
        assert!(f.reason.contains("не поддерживается"));
    }
    #[test]
    fn validation_rejects_unsafe_shapes() {
        let mut bad = game();
        bad.actions[0].tool = "client.shell_exec".into();
        assert!(validate(&bad).is_err());
        let mut bad = game();
        bad.actions[0].arguments = json!({"path":"/a","extra":"b"});
        assert!(validate(&bad).is_err());
        let mut bad = game();
        bad.actions[0].arguments = json!({"path":"{missing}"});
        assert!(validate(&bad).unwrap_err().contains("не объявлен"));
        let mut bad = game();
        bad.triggers = vec![Trigger {
            regex: Some("(".into()),
            ..Default::default()
        }];
        assert!(validate(&bad).is_err());
        let mut bad = game();
        bad.triggers = vec![Trigger {
            phrase: Some("a".into()),
            regex: Some("b".into()),
            hotkey: None,
        }];
        assert!(validate(&bad).is_err());
        let mut bad = game();
        bad.actions = (0..11).map(|_| bad.actions[0].clone()).collect();
        assert!(validate(&bad).is_err());
        let mut bad = game();
        bad.name = "a\u{0007}b".into();
        assert!(validate(&bad).is_err());
        let mut closing = game();
        closing.actions = vec![Action {
            tool: "client.close_window".into(),
            arguments: json!({"window":"0x1"}),
        }];
        assert!(validate(&closing).unwrap_err().contains("risk: confirm"));
        closing.risk = Risk::Confirm;
        assert!(validate(&closing).is_ok());
    }
    #[test]
    fn regex_cannot_blow_up_and_must_declare_captures() {
        let mut c = game();
        c.triggers = vec![Trigger {
            regex: Some("(a+)+$".into()),
            ..Default::default()
        }];
        assert!(validate(&c).is_ok());
        let started = std::time::Instant::now();
        let m = find_match(&[c.clone()], &format!("{}!", "a".repeat(5000)));
        assert_eq!(m, Match::None);
        assert!(started.elapsed().as_secs() < 2);
        c.triggers = vec![Trigger {
            regex: Some("(?P<city>.+)".into()),
            ..Default::default()
        }];
        assert!(validate(&c).unwrap_err().contains("city"));
        c.triggers = vec![Trigger {
            regex: Some("x".repeat(121)),
            ..Default::default()
        }];
        assert!(validate(&c).is_err());
    }
    #[test]
    fn hotkeys_are_canonical_and_never_steal_ptt_or_stop() {
        assert_eq!(canonical_hotkey("alt + ctrl + g").unwrap(), "Ctrl+Alt+G");
        assert_eq!(canonical_hotkey("Super+F5").unwrap(), "Super+F5");
        for bad in [
            "g",
            "Shift+G",
            "Ctrl+Alt+Space",
            "Ctrl+Alt+Escape",
            "Ctrl+F13",
            "Ctrl+AB",
            "Ctrl+Alt",
            "Ctrl+G+H",
        ] {
            assert!(canonical_hotkey(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn matching_is_normalized_exact_and_ambiguity_falls_back_to_llm() {
        let cmds = vec![game(), simple("Музыка", "Включи музыку")];
        assert!(matches!(
            find_match(&cmds, "Нейра, РЕЖИМ  игры!"),
            Match::One(0, _)
        ));
        assert_eq!(find_match(&cmds, "режим игры пожалуйста"), Match::None);
        assert!(matches!(
            find_match(&cmds, "включи музыку"),
            Match::One(1, _)
        ));
        let twins = vec![simple("A", "тест тест"), simple("B", "Тест, тест")];
        assert!(
            matches!(find_match(&twins, "тест тест"), Match::Ambiguous(names) if names == ["A", "B"])
        );
        let mut off = simple("C", "выключено");
        off.enabled = false;
        assert_eq!(find_match(&[off], "выключено"), Match::None);
        assert_eq!(find_match(&cmds, "   "), Match::None);
        assert_eq!(normalize("Нейра, Ёлка!"), "елка");
        assert_eq!(normalize("нейра"), "нейра");
    }
    #[test]
    fn regex_captures_fill_parameters_and_policy_sees_final_values() {
        let mut c = game();
        c.params = vec![Param {
            name: "site".into(),
            default: Some("example.com".into()),
            description: String::new(),
        }];
        c.triggers = vec![Trigger {
            regex: Some("открой сайт (?P<site>[a-z.-]+)".into()),
            ..Default::default()
        }];
        c.actions = vec![Action {
            tool: "client.open_url".into(),
            arguments: json!({"url":"https://{site}/"}),
        }];
        validate(&c).unwrap();
        let Match::One(0, params) = find_match(&[c.clone()], "Нейра, Открой сайт rust-lang.org")
        else {
            panic!("no match")
        };
        assert_eq!(params["site"], "rust-lang.org");
        assert_eq!(
            render(&c, &params).unwrap()[0].1["url"],
            "https://rust-lang.org/"
        );
        assert_eq!(
            render(&c, &HashMap::new()).unwrap()[0].1["url"],
            "https://example.com/"
        );
        c.params[0].default = None;
        assert!(render(&c, &HashMap::new()).unwrap_err().contains("site"));
        let evil = HashMap::from([("site".to_string(), "x\ny".to_string())]);
        assert!(render(&c, &evil).is_err());
        let perms = Permissions {
            enabled: true,
            web_domains: vec!["rust-lang.org".into()],
            ..Default::default()
        };
        let known = HashMap::from([("site".to_string(), "rust-lang.org".to_string())]);
        assert_eq!(dry_run(&c, &known, &perms, "d").unwrap()[0].verdict, "safe");
        let other = HashMap::from([("site".to_string(), "other.example".to_string())]);
        assert_eq!(
            dry_run(&c, &other, &perms, "d").unwrap()[0].verdict,
            "confirm"
        );
        let bad = HashMap::from([("site".to_string(), "../../etc".to_string())]);
        assert_eq!(
            dry_run(&c, &bad, &perms, "d").unwrap()[0].verdict,
            "confirm"
        );
    }
    #[test]
    fn dry_run_respects_master_switch_and_unavailable_tools() {
        let c = game();
        let off = Permissions::default();
        assert!(dry_run(&c, &HashMap::new(), &off, "d")
            .unwrap()
            .iter()
            .all(|p| p.verdict == "denied"));
        let on = Permissions {
            enabled: true,
            system: false,
            ..Default::default()
        };
        assert!(dry_run(&c, &HashMap::new(), &on, "d")
            .unwrap()
            .iter()
            .all(|p| p.verdict == "unavailable"));
    }
    #[test]
    fn commands_cannot_reach_arbitrary_tools_or_secret_paths() {
        let perms = Permissions {
            enabled: true,
            ..Default::default()
        };
        let mut c = game();
        c.actions = vec![Action {
            tool: "client.open_app".into(),
            arguments: json!({"path":"/home/me/.ssh/id_rsa"}),
        }];
        assert_eq!(
            dry_run(&c, &HashMap::new(), &perms, "d").unwrap()[0].verdict,
            "denied"
        );
    }
    #[test]
    fn store_hot_reload_keeps_last_valid_and_isolates_broken_files() {
        let dir = temp();
        fs::write(dir.join("game.yaml"), GAME).unwrap();
        fs::write(
            dir.join("music.yaml"),
            GAME.replace("Режим игры", "Музыка")
                .replace("режим игры", "музыка")
                .replace("ctrl+alt+g", "ctrl+alt+m"),
        )
        .unwrap();
        fs::write(dir.join("notes.txt"), "ignored").unwrap();
        let mut store = Store::default();
        assert!(store.dirty(&dir));
        assert!(store.reload(&dir));
        assert_eq!(store.entries().len(), 2);
        assert!(!store.dirty(&dir) && !store.reload(&dir));
        std::thread::sleep(std::time::Duration::from_millis(15));
        fs::write(dir.join("game.yaml"), "name: Режим игры\ntriggers: [\n").unwrap();
        assert!(store.dirty(&dir) && store.reload(&dir));
        assert_eq!(store.entries().len(), 2, "last valid version stays active");
        assert_eq!(store.errors().len(), 1);
        assert!(
            store.errors()[0].kept_previous
                && store.errors()[0].file == "game.yaml"
                && store.errors()[0].line.is_some()
        );
        fs::write(dir.join("broken-new.yaml"), "nope: [").unwrap();
        store.reload(&dir);
        assert_eq!(store.entries().len(), 2);
        assert!(store
            .errors()
            .iter()
            .any(|e| e.file == "broken-new.yaml" && !e.kept_previous));
        fs::write(dir.join("game.yaml"), GAME).unwrap();
        fs::remove_file(dir.join("broken-new.yaml")).unwrap();
        store.reload(&dir);
        assert!(store.errors().is_empty());
        fs::remove_file(dir.join("music.yaml")).unwrap();
        store.reload(&dir);
        assert_eq!(store.entries().len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn duplicate_names_hotkeys_oversized_files_and_symlinks_are_reported() {
        let dir = temp();
        fs::write(dir.join("a.yaml"), GAME).unwrap();
        fs::write(dir.join("b.yaml"), GAME).unwrap();
        fs::write(
            dir.join("c.yaml"),
            GAME.replace("Режим игры", "Другая")
                .replace("режим игры", "другая"),
        )
        .unwrap();
        fs::write(
            dir.join("big.yaml"),
            vec![b'#'; (MAX_FILE_BYTES + 1) as usize],
        )
        .unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("a.yaml"), dir.join("link.yaml")).unwrap();
        let mut store = Store::default();
        store.reload(&dir);
        assert_eq!(
            store
                .entries()
                .iter()
                .map(|e| e.file.as_str())
                .collect::<Vec<_>>(),
            ["a.yaml"]
        );
        let reasons: Vec<_> = store
            .errors()
            .iter()
            .map(|e| (e.file.as_str(), e.reason.as_str()))
            .collect();
        assert!(reasons
            .iter()
            .any(|(f, r)| *f == "b.yaml" && r.contains("уже занято")));
        assert!(reasons
            .iter()
            .any(|(f, r)| *f == "c.yaml" && r.contains("Хоткей")));
        assert!(reasons
            .iter()
            .any(|(f, r)| *f == "big.yaml" && r.contains("64")));
        #[cfg(unix)]
        assert!(reasons.iter().any(|(f, _)| *f == "link.yaml"));
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn save_creates_safe_unique_file_names_and_rejects_duplicates() {
        let dir = temp();
        let evil = simple("../../etc/passwd", "эвил тест");
        let file = write_command(&dir, &[], None, &evil, None).unwrap();
        assert_eq!(file, "etc-passwd.yaml");
        assert!(dir.join(&file).exists() && fs::read_dir(&dir).unwrap().count() == 1);
        let again = write_command(&dir, &[], None, &simple("etc passwd", "другое"), None).unwrap();
        assert_eq!(again, "etc-passwd-2.yaml");
        let existing = [Entry {
            file: file.clone(),
            command: evil.clone(),
        }];
        assert!(write_command(
            &dir,
            &existing,
            None,
            &simple("../../ETC/passwd", "ещё тест"),
            None
        )
        .unwrap_err()
        .contains("имен"));
        assert!(write_command(&dir, &existing, Some(&file), &evil, None).is_ok());
        assert_eq!(slug("CON"), "cmd-con");
        assert_eq!(slug("???"), "command");
        assert!(slug(&"я".repeat(100)).chars().count() <= 48);
        for bad in [
            "../x.yaml",
            "a/b.yaml",
            "a\\b.yaml",
            ".hidden.yaml",
            "x.txt",
            "C:evil.yaml",
            "",
        ] {
            assert!(safe_file_name(bad).is_err(), "{bad}");
        }
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn raw_yaml_is_preserved_when_saved_and_delete_is_confined() {
        let dir = temp();
        let raw = format!("# моя заметка\n{GAME}");
        let command = parse(&raw).map_err(|f| f.reason).unwrap();
        let file = write_command(&dir, &[], None, &command, Some(&raw)).unwrap();
        assert!(fs::read_to_string(dir.join(&file))
            .unwrap()
            .starts_with("# моя заметка"));
        assert!(delete_file(&dir, "../outside.yaml").is_err());
        fs::write(dir.parent().unwrap().join(format!("{file}.outside")), "x").ok();
        delete_file(&dir, &file).unwrap();
        assert!(delete_file(&dir, &file).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn drafts_become_validated_commands_with_computed_risk() {
        let draft = json!({"name":"Закрыть","phrases":["закрой окно"],"actions":[{"tool":"client.close_window","arguments":{"window":"0x1"}}],"reply":"Готово"});
        let c = from_draft(&draft).unwrap();
        assert_eq!((c.risk, c.reply.as_str()), (Risk::Confirm, "Готово"));
        for bad in [
            json!({"name":"x","phrases":["аб"],"actions":[{"tool":"client.shell_exec","arguments":{}}]}),
            json!({"name":"","phrases":["аб"],"actions":[{"tool":"client.list_apps","arguments":{}}]}),
            json!({"name":"x","phrases":[],"actions":[{"tool":"client.list_apps","arguments":{}}]}),
            json!("string"),
        ] {
            assert!(from_draft(&bad).is_err());
        }
    }
    #[test]
    fn manifest_info_has_no_arguments_or_regexes_and_is_bounded() {
        let mut with_regex = game();
        with_regex.triggers.push(Trigger {
            regex: Some("секрет.*".into()),
            ..Default::default()
        });
        let entries = vec![Entry {
            file: "a.yaml".into(),
            command: with_regex,
        }];
        let text = serde_json::to_string(&manifest_info(&entries)).unwrap();
        assert!(
            !text.contains("steam")
                && !text.contains("секрет")
                && text.contains("Ctrl+Alt+G")
                && text.contains("client.open_app")
        );
        let many: Vec<_> = (0..40)
            .map(|i| Entry {
                file: format!("{i}.yaml"),
                command: simple(&format!("К{i}"), &format!("фраза номер {i}")),
            })
            .collect();
        assert!(manifest_info(&many).len() <= 32);
        let mut disabled = simple("Выкл", "выкл тест");
        disabled.enabled = false;
        assert!(manifest_info(&[Entry {
            file: "x.yaml".into(),
            command: disabled
        }])
        .is_empty());
    }
    fn settings() -> crate::storage::Settings {
        crate::storage::Settings {
            profiles: vec![crate::storage::Profile {
                id: uuid::Uuid::new_v4().to_string(),
                name: "Сервер".into(),
                url: "https://secret.example".into(),
                session_id: uuid::Uuid::new_v4().to_string(),
            }],
            ..Default::default()
        }
    }
    #[test]
    fn export_contains_no_identity_profiles_tokens_or_audit() {
        let s = settings();
        let text = serde_json::to_string(&export_bundle(
            &s,
            &[Entry {
                file: "a.yaml".into(),
                command: game(),
            }],
        ))
        .unwrap();
        for forbidden in [
            s.device_id.as_str(),
            "secret.example",
            "session",
            "token",
            "audit_log",
            "profiles",
        ] {
            assert!(!text.contains(forbidden), "{forbidden}");
        }
        assert!(text.contains(BUNDLE_FORMAT) && text.contains("Режим игры"));
        let back = parse_bundle(text.as_bytes()).unwrap();
        assert_eq!(back.commands.len(), 1);
    }
    #[test]
    fn import_rejects_foreign_oversized_and_unknown_content() {
        assert!(parse_bundle(b"not json").is_err());
        assert!(parse_bundle(br#"{"format":"other","exported_at_ms":1,"settings":{"theme":"dark","graphics_mode":"auto","audit_days":30},"permissions":{},"commands":[]}"#).is_err());
        assert!(parse_bundle(&vec![b' '; (MAX_BUNDLE_BYTES + 1) as usize]).is_err());
        let sneaky = br#"{"format":"neyra.config.v1","exported_at_ms":1,"settings":{"theme":"dark","graphics_mode":"auto","audit_days":30},"permissions":{},"commands":[],"token":"x"}"#;
        assert!(parse_bundle(sneaky).is_err());
        let many = json!({"format":BUNDLE_FORMAT,"exported_at_ms":1,"settings":{"theme":"dark","graphics_mode":"auto","audit_days":30},"permissions":{},"commands":vec![json!({}); MAX_COMMANDS + 1]});
        assert!(parse_bundle(many.to_string().as_bytes())
            .unwrap_err()
            .contains("больше"));
    }
    fn bundle_with(commands: Vec<Value>) -> Bundle {
        Bundle {
            format: BUNDLE_FORMAT.into(),
            exported_at_ms: 1,
            settings: BundleSettings {
                theme: "dark".into(),
                graphics_mode: "auto".into(),
                audit_days: 30,
            },
            permissions: Permissions::default(),
            commands,
        }
    }
    #[test]
    fn import_preview_marks_new_same_conflict_and_invalid() {
        let existing = vec![Entry {
            file: "a.yaml".into(),
            command: game(),
        }];
        let mut changed = game();
        changed.reply = "Другой ответ".into();
        let mut bad = serde_json::to_value(simple("Плохая", "плохо плохо")).unwrap();
        bad["actions"][0]["tool"] = json!("client.shell_exec");
        let bundle = bundle_with(vec![
            serde_json::to_value(game()).unwrap(),
            serde_json::to_value(&changed).unwrap(),
            serde_json::to_value(simple("Новая", "новая фраза")).unwrap(),
            bad,
            json!({"nonsense":true}),
            serde_json::to_value(simple("НОВАЯ", "другое")).unwrap(),
        ]);
        let (items, valid) = plan_import(&bundle, &existing);
        let statuses: Vec<_> = items.iter().map(|i| i.status).collect();
        assert_eq!(
            statuses,
            ["same", "invalid", "new", "invalid", "invalid", "invalid"]
        );
        assert_eq!(items[1].error.as_deref(), Some("Имя повторяется в файле"));
        assert_eq!(valid.len(), 2);
    }
    #[test]
    fn import_apply_merge_policies_and_replace_backup() {
        let dir = temp();
        let backup = temp().join("backup");
        let first = write_command(&dir, &[], None, &game(), None).unwrap();
        let existing = vec![Entry {
            file: first.clone(),
            command: game(),
        }];
        let mut other = game();
        other.reply = "Из импорта".into();
        other.triggers = vec![
            Trigger {
                phrase: Some("режим игры".into()),
                hotkey: None,
                regex: None,
            },
            Trigger {
                hotkey: Some("ctrl+alt+g".into()),
                ..Default::default()
            },
        ];
        let skip = apply_import(
            &dir,
            &backup,
            &existing,
            vec![other.clone()],
            false,
            Conflict::Skip,
        )
        .unwrap();
        assert_eq!(
            skip,
            ImportReport {
                skipped: 1,
                ..Default::default()
            }
        );
        let renamed = apply_import(
            &dir,
            &backup,
            &existing,
            vec![other.clone()],
            false,
            Conflict::Rename,
        )
        .unwrap();
        assert_eq!(renamed.renamed, 1);
        let mut store = Store::default();
        store.reload(&dir);
        assert_eq!(store.entries().len(), 2);
        let imported = store
            .entries()
            .iter()
            .find(|e| e.command.name.contains("(импорт)"))
            .unwrap();
        assert!(
            hotkeys_of(&imported.command).is_empty(),
            "foreign hotkey must not duplicate an existing one"
        );
        let over = apply_import(
            &dir,
            &backup,
            store.entries(),
            vec![other.clone()],
            false,
            Conflict::Overwrite,
        )
        .unwrap();
        assert_eq!(over.replaced, 1);
        store.reload(&dir);
        assert_eq!(
            store
                .entries()
                .iter()
                .find(|e| e.file == first)
                .unwrap()
                .command
                .reply,
            "Из импорта"
        );
        let replaced = apply_import(
            &dir,
            &backup,
            store.entries(),
            vec![simple("Единственная", "единственная фраза")],
            true,
            Conflict::Skip,
        )
        .unwrap();
        assert_eq!(replaced.added, 1);
        store.reload(&dir);
        assert_eq!(store.entries().len(), 1);
        assert_eq!(
            fs::read_dir(&backup).unwrap().count(),
            2,
            "old commands are kept in the backup folder"
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn import_with_traversal_names_stays_inside_commands_folder() {
        let dir = temp();
        let evil = vec![
            simple("../../../tmp/pwned", "эвил фраза"),
            simple("..\\..\\windows\\system32\\x", "эвил два"),
        ];
        apply_import(&dir, &dir.join("b"), &[], evil, false, Conflict::Skip).unwrap();
        for entry in fs::read_dir(&dir).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            assert!(safe_file_name(&name).is_ok(), "{name}");
        }
        assert!(!std::path::Path::new("/tmp/pwned.yaml").exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
