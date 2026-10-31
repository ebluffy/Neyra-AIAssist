use crate::files::Scope;
use crate::policy::{child_environment, secret_path};
use crate::redact::bounded_text;
use serde_json::{json, Map, Value};
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

pub const MAX_TIMEOUT_MS: u64 = 60_000;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const OUTPUT_KEEP: usize = 64 * 1024;
const STDOUT_RETURN: usize = 16 * 1024;
const STDERR_RETURN: usize = 8 * 1024;
const MAX_ARGS: usize = 64;
const MAX_ARGS_BYTES: usize = 16 * 1024;

/// Programs that grant or request higher privileges. The agent never elevates.
const ELEVATION: &[&str] = &[
    "sudo",
    "sudo-rs",
    "su",
    "doas",
    "pkexec",
    "run0",
    "runas",
    "gsudo",
    "gksu",
    "gksudo",
    "kdesu",
    "kdesudo",
    "lxsudo",
    "beesu",
    "sudoedit",
    "machinectl",
];

const ENV_DENY: &[&str] = &[
    "PATH",
    "PATHEXT",
    "COMSPEC",
    "PSMODULEPATH",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "PYTHONHOME",
    "NODE_OPTIONS",
    "NODE_PATH",
    "PERL5OPT",
    "PERL5LIB",
    "RUBYOPT",
    "RUBYLIB",
    "BASH_ENV",
    "ENV",
    "PROMPT_COMMAND",
    "IFS",
    "SHELLOPTS",
    "BASHOPTS",
    "CDPATH",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_EXEC_PATH",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "SUDO_ASKPASS",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "SYSTEMROOT",
    "WINDIR",
    "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS",
    "DOTNET_STARTUP_HOOKS",
    "ZDOTDIR",
];

pub struct Plan {
    pub program: PathBuf,
    /// Name the caller asked for. Multicall binaries (busybox) read this, not the canonical path.
    pub argv0: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub timeout: Duration,
}

fn stem(path: &str) -> String {
    let name = path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_lowercase();
    for ext in [".exe", ".cmd", ".bat", ".com", ".ps1"] {
        if let Some(s) = name.strip_suffix(ext) {
            return s.to_string();
        }
    }
    name
}

fn words(text: &str) -> impl Iterator<Item = &str> {
    text.split(|c: char| c.is_whitespace() || "\"'`;|&()<>{}$=,".contains(c))
        .filter(|w| !w.is_empty())
}

fn path_like_secret(word: &str) -> bool {
    let expanded = if let Some(rest) = word.strip_prefix('~') {
        dirs::home_dir()
            .map(|h| h.join(rest.trim_start_matches(['/', '\\'])))
            .unwrap_or_else(|| PathBuf::from(word))
    } else {
        PathBuf::from(word)
    };
    secret_path(&expanded) || secret_path(Path::new(&format!("/{word}")))
}

fn resolve_program(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() || raw.len() > 1024 || raw.contains('\0') {
        return Err("Неверная программа".into());
    }
    let candidate = if raw.contains(['/', '\\']) {
        let path = PathBuf::from(raw);
        if !path.is_absolute() {
            return Err("Путь к программе должен быть абсолютным".into());
        }
        path
    } else {
        find_in_path(raw).ok_or("Программа не найдена в PATH")?
    };
    let real = std::fs::canonicalize(&candidate).map_err(|_| "Программа не найдена")?;
    if !real.is_file() || secret_path(&real) {
        return Err("Программа недоступна".into());
    }
    Ok(real)
}

fn requested_name(raw: &str) -> String {
    raw.rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(raw)
        .to_string()
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    let exts: Vec<String> = if cfg!(windows) {
        let mut e = vec![String::new()];
        e.extend([".exe", ".com", ".cmd", ".bat"].map(String::from));
        e
    } else {
        vec![String::new()]
    };
    std::env::split_paths(&paths).find_map(|dir| {
        exts.iter()
            .map(|ext| dir.join(format!("{name}{ext}")))
            .find(|p| p.is_file())
    })
}

/// Validates a structured command. It never goes through a shell string unless the
/// caller explicitly names a shell as the program, and it is always confirmed by the user.
pub fn plan(args: &Map<String, Value>, scope: &Scope) -> Result<Plan, String> {
    let program_raw = args
        .get("program")
        .and_then(Value::as_str)
        .ok_or("Нужна программа")?;
    let program = resolve_program(program_raw)?;
    let argv: Vec<String> = match args.get("args") {
        None => vec![],
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_string)
                    .ok_or("Аргументы должны быть строками")
            })
            .collect::<Result<_, _>>()?,
        Some(_) => return Err("Аргументы должны быть списком".into()),
    };
    if argv.len() > MAX_ARGS
        || argv.iter().map(String::len).sum::<usize>() > MAX_ARGS_BYTES
        || argv.iter().any(|a| a.contains('\0'))
    {
        return Err("Слишком длинная команда".into());
    }
    let program_text = program.to_string_lossy().to_string();
    for word in std::iter::once(program_raw)
        .chain(std::iter::once(program_text.as_str()))
        .chain(argv.iter().flat_map(|a| words(a)))
    {
        if ELEVATION.contains(&stem(word).as_str()) {
            return Err("Повышение прав агенту запрещено".into());
        }
        if path_like_secret(word) {
            return Err("Команда обращается к секретам".into());
        }
    }
    let joined = argv.join(" ").to_lowercase();
    if joined.contains("-verb runas") || joined.contains("-verb:runas") {
        return Err("Повышение прав агенту запрещено".into());
    }
    let cwd = match args.get("cwd") {
        None | Some(Value::Null) => scope
            .first_root()
            .map(Path::to_path_buf)
            .or_else(dirs::home_dir)
            .ok_or("Не найдена рабочая папка")?,
        Some(Value::String(raw)) => {
            let real = scope.existing(raw)?;
            if !real.is_dir() {
                return Err("Рабочая папка не найдена".into());
            }
            real
        }
        Some(_) => return Err("Неверная рабочая папка".into()),
    };
    let mut env = Vec::new();
    if let Some(value) = args.get("env") {
        let map = value
            .as_object()
            .ok_or("Переменные окружения должны быть объектом")?;
        if map.len() > 16 {
            return Err("Слишком много переменных окружения".into());
        }
        for (key, value) in map {
            let ok_key = !key.is_empty()
                && key.len() <= 64
                && key
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            let upper = key.to_ascii_uppercase();
            if !ok_key
                || ENV_DENY.contains(&upper.as_str())
                || upper.starts_with("LD_")
                || upper.starts_with("DYLD_")
                || upper.contains("PRELOAD")
            {
                return Err("Эту переменную окружения задавать нельзя".into());
            }
            let value = value
                .as_str()
                .ok_or("Значение переменной должно быть строкой")?;
            if value.len() > 1024 || value.contains('\0') {
                return Err("Слишком длинное значение переменной".into());
            }
            env.push((key.clone(), value.to_string()));
        }
    }
    let timeout_ms = match args.get("timeout_ms") {
        None | Some(Value::Null) => DEFAULT_TIMEOUT_MS,
        Some(v) => v
            .as_u64()
            .filter(|t| (1000..=MAX_TIMEOUT_MS).contains(t))
            .ok_or("Таймаут должен быть от 1 до 60 секунд")?,
    };
    Ok(Plan {
        program,
        argv0: requested_name(program_raw),
        args: argv,
        cwd,
        env,
        timeout: Duration::from_millis(timeout_ms),
    })
}

pub fn preview(plan: &Plan) -> String {
    let quoted: Vec<String> = std::iter::once(plan.argv0.clone())
        .chain(plan.args.iter().cloned())
        .map(|a| shlex::try_quote(&a).map(|q| q.into_owned()).unwrap_or(a))
        .collect();
    let program = plan.program.to_string_lossy();
    let file_name = plan
        .program
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let mut command = quoted.join(" ");
    if plan.argv0 != file_name {
        let shown = shlex::try_quote(program.as_ref())
            .map(|quoted| quoted.into_owned())
            .unwrap_or_else(|_| program.to_string());
        command.push_str(&format!(" (→ {shown})"));
    }
    let mut text = format!(
        "Команда: {command}\nФайл: {program}\nПапка: {}\nТаймаут: {} с",
        plan.cwd.to_string_lossy(),
        plan.timeout.as_secs()
    );
    if !plan.env.is_empty() {
        let keys: Vec<&str> = plan.env.iter().map(|(k, _)| k.as_str()).collect();
        text.push_str(&format!("\nПеременные: {}", keys.join(", ")));
    }
    text
}

fn reader<R: Read + Send + 'static>(stream: R) -> std::thread::JoinHandle<(Vec<u8>, bool)> {
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        let mut stream = stream;
        let mut buffer = [0u8; 8192];
        let mut overflow = false;
        // Keep reading (and discarding) so a chatty child never blocks on a full pipe.
        while let Ok(n) = stream.read(&mut buffer) {
            if n == 0 {
                break;
            }
            let room = OUTPUT_KEEP.saturating_sub(kept.len());
            kept.extend_from_slice(&buffer[..n.min(room)]);
            overflow |= n > room;
        }
        (kept, overflow)
    })
}

fn set_argv0(command: &mut Command, argv0: &str) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.arg0(argv0);
    }
    // Windows CreateProcess has no separate argv0; multicall applets are a Unix problem.
    #[cfg(not(unix))]
    let _ = (command, argv0);
}

pub fn run(plan: &Plan, cancel: &AtomicBool) -> Result<Value, String> {
    let mut command = Command::new(&plan.program);
    // Exec the real file, but keep the name the user typed so busybox-style applets still work.
    set_argv0(&mut command, &plan.argv0);
    child_environment(&mut command);
    command
        .args(&plan.args)
        .current_dir(&plan.cwd)
        .envs(plan.env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let tree = tree::Tree::prepare(&mut command);
    let mut child = command.spawn().map_err(|_| "Программа не запустилась")?;
    let tree = tree.attach(&child);
    let out = reader(child.stdout.take().ok_or("Нет потока вывода")?);
    let err = reader(child.stderr.take().ok_or("Нет потока ошибок")?);
    let started = Instant::now();
    let (status, outcome) = loop {
        if cancel.load(Ordering::SeqCst) {
            tree.kill(&mut child);
            break (None, "cancelled");
        }
        if started.elapsed() > plan.timeout {
            tree.kill(&mut child);
            break (None, "timeout");
        }
        if let Ok(Some(status)) = child.try_wait() {
            break (Some(status), "ok");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    // Background descendants of a CLI call do not outlive it; this also releases the pipes.
    tree.kill(&mut child);
    let _ = child.wait();
    let (stdout, stdout_overflow) = out.join().unwrap_or_default();
    let (stderr, stderr_overflow) = err.join().unwrap_or_default();
    let (stdout, stdout_cut) = bounded_text(&stdout, STDOUT_RETURN);
    let (stderr, stderr_cut) = bounded_text(&stderr, STDERR_RETURN);
    Ok(json!({
        "status": outcome,
        "exit_code": status.and_then(|s| s.code()),
        "stdout": stdout,
        "stderr": stderr,
        "stdout_truncated": stdout_cut || stdout_overflow,
        "stderr_truncated": stderr_cut || stderr_overflow,
        "elapsed_ms": started.elapsed().as_millis() as u64,
    }))
}

#[cfg(unix)]
mod tree {
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command};

    pub struct Tree(i32);
    pub struct Pending;

    impl Pending {
        pub fn attach(self, child: &Child) -> Tree {
            Tree(child.id() as i32)
        }
    }
    impl Tree {
        pub fn prepare(command: &mut Command) -> Pending {
            // Own process group: every descendant can be signalled together.
            command.process_group(0);
            Pending
        }
        pub fn kill(&self, child: &mut Child) {
            unsafe {
                libc::kill(-self.0, libc::SIGKILL);
            }
            let _ = child.kill();
        }
    }
}

#[cfg(windows)]
mod tree {
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command};

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        per_process_user_time: i64,
        per_job_user_time: i64,
        limit_flags: u32,
        min_working_set: usize,
        max_working_set: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io: [u64; 6],
        process_memory: usize,
        job_memory: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *const std::ffi::c_void, name: *const u16) -> isize;
        fn SetInformationJobObject(
            job: isize,
            class: i32,
            info: *const std::ffi::c_void,
            len: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: isize, process: isize) -> i32;
        fn TerminateJobObject(job: isize, code: u32) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }
    const KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

    pub struct Pending(isize);
    pub struct Tree(isize);

    impl Pending {
        pub fn attach(self, child: &Child) -> Tree {
            if self.0 != 0 {
                unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as isize) };
            }
            Tree(self.0)
        }
    }
    impl Tree {
        pub fn prepare(command: &mut Command) -> Pending {
            command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
            let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if job != 0 {
                let mut limits = ExtendedLimits::default();
                limits.basic.limit_flags = KILL_ON_JOB_CLOSE;
                unsafe {
                    SetInformationJobObject(
                        job,
                        EXTENDED_LIMIT_INFORMATION,
                        &limits as *const _ as *const std::ffi::c_void,
                        std::mem::size_of::<ExtendedLimits>() as u32,
                    )
                };
            }
            Pending(job)
        }
        pub fn kill(&self, child: &mut Child) {
            if self.0 != 0 {
                unsafe { TerminateJobObject(self.0, 1) };
            }
            let _ = child.kill();
        }
    }
    impl Drop for Tree {
        fn drop(&mut self) {
            if self.0 != 0 {
                unsafe { CloseHandle(self.0) };
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scope() -> (Scope, PathBuf) {
        let base = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("neyra-sh-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(base.join("work")).unwrap();
        (
            Scope::new(
                &[base.join("work").to_string_lossy().into_owned()],
                &base.join("data"),
            ),
            base,
        )
    }
    fn args(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn preview_leads_with_argv0_and_names_the_file() {
        let plan = Plan {
            program: PathBuf::from("/usr/bin/busybox"),
            argv0: "sh".into(),
            args: vec!["-c".into(), "true".into()],
            cwd: PathBuf::from("/tmp"),
            env: Vec::new(),
            timeout: Duration::from_secs(30),
        };
        let card = preview(&plan);
        assert!(card.starts_with("Команда: sh "));
        assert!(card.contains("(→ /usr/bin/busybox)"));
        assert!(card.contains("Файл: /usr/bin/busybox"));
    }

    #[test]
    fn elevation_is_rejected_directly_and_inside_shell_strings() {
        let (scope, base) = scope();
        for bad in [
            json!({"program":"sudo","args":["id"]}),
            json!({"program":"sh","args":["-c","sudo rm -rf /"]}),
            json!({"program":"sh","args":["-c","echo x | pkexec tee /etc/x"]}),
            json!({"program":"sh","args":["-c","Start-Process cmd -Verb RunAs"]}),
        ] {
            assert!(plan(&args(bad.clone()), &scope).is_err(), "{bad}");
        }
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn secrets_and_dangerous_env_are_rejected() {
        let (scope, base) = scope();
        for bad in [
            json!({"program":"sh","args":["-c","cat ~/.ssh/id_rsa"]}),
            json!({"program":"cat","args":["/home/u/.aws/credentials"]}),
            json!({"program":"sh","args":["-c","cat .env"]}),
            json!({"program":"sh","args":["-c","true"],"env":{"LD_PRELOAD":"/tmp/x.so"}}),
            json!({"program":"sh","args":["-c","true"],"env":{"PATH":"/tmp"}}),
            json!({"program":"sh","args":["-c","true"],"env":{"bad-key":"x"}}),
            json!({"program":"sh","args":["-c","true"],"timeout_ms":3_600_000}),
            json!({"program":"./relative","args":[]}),
            json!({"program":"sh","args":["-c","true"],"cwd":"/etc"}),
        ] {
            assert!(plan(&args(bad.clone()), &scope).is_err(), "{bad}");
        }
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(unix)]
    #[test]
    fn output_is_bounded_redacted_and_exit_code_kept() {
        let (scope, base) = scope();
        let marker = format!("{}{}", "abcdef", "123456");
        let script = format!(
            "echo TOKEN={marker}; head -c 100000 /dev/zero | tr '\\0' a; echo err >&2; exit 3"
        );
        let p = plan(&args(json!({"program":"sh","args":["-c", script]})), &scope).unwrap();
        assert!(preview(&p).contains("Команда:"));
        let out = run(&p, &AtomicBool::new(false)).unwrap();
        assert_eq!(out["exit_code"], 3);
        assert_eq!(out["stdout_truncated"], true);
        assert!(!out["stdout"].as_str().unwrap().contains(&marker));
        assert!(out["stdout"].as_str().unwrap().len() <= STDOUT_RETURN + 32);
        assert_eq!(out["stderr"].as_str().unwrap().trim(), "err");
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(unix)]
    #[test]
    fn argv0_is_the_requested_name_not_the_canonical_path() {
        let (scope, base) = scope();
        let p = plan(
            &args(json!({"program":"sh","args":["-c","printf %s \"$0\""]})),
            &scope,
        )
        .unwrap();
        assert_eq!(p.argv0, "sh");
        assert_ne!(p.program.as_os_str(), "sh");
        let card = preview(&p);
        assert!(
            card.starts_with("Команда: sh "),
            "confirm card must lead with argv0, got {card}"
        );
        assert!(
            card.contains(&*p.program.to_string_lossy()),
            "confirm card must name the canonical file, got {card}"
        );
        let out = run(&p, &AtomicBool::new(false)).unwrap();
        assert_eq!(out["stdout"].as_str().unwrap(), "sh");
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(unix)]
    #[test]
    fn timeout_and_cancel_kill_the_whole_tree() {
        let (scope, base) = scope();
        let marker = base.join("work/grandchild.pid");
        let script = format!("sleep 30 & echo $! > {}; wait", marker.to_string_lossy());
        let p = plan(
            &args(json!({"program":"sh","args":["-c",script],"timeout_ms":1000})),
            &scope,
        )
        .unwrap();
        let started = Instant::now();
        let out = run(&p, &AtomicBool::new(false)).unwrap();
        assert_eq!(out["status"], "timeout");
        assert!(started.elapsed() < Duration::from_secs(5));
        let pid: i32 = std::fs::read_to_string(&marker)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert_ne!(unsafe { libc::kill(pid, 0) }, 0, "grandchild survived");

        let cancel = AtomicBool::new(true);
        let p = plan(&args(json!({"program":"sleep","args":["30"]})), &scope).unwrap();
        assert_eq!(run(&p, &cancel).unwrap()["status"], "cancelled");
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(unix)]
    #[test]
    fn background_children_do_not_outlive_a_finished_call() {
        let (scope, base) = scope();
        let marker = base.join("work/bg.pid");
        let script = format!(
            "sleep 30 > /dev/null 2>&1 & echo $! > {}",
            marker.to_string_lossy()
        );
        let p = plan(&args(json!({"program":"sh","args":["-c",script]})), &scope).unwrap();
        let out = run(&p, &AtomicBool::new(false)).unwrap();
        assert_eq!(out["status"], "ok");
        let pid: i32 = std::fs::read_to_string(&marker)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert_ne!(
            unsafe { libc::kill(pid, 0) },
            0,
            "background child survived"
        );
        let _ = std::fs::remove_dir_all(base);
    }
}
