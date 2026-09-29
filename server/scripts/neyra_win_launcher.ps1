# Neyra Windows launcher (UTF-8). Called from run_neyra.bat — avoids cmd.exe encoding/parenthesis bugs.
#Requires -Version 5.1
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = "Neyra · control deck"

function Ensure-WindowsToolPath {
    # После переноса проекта / урезанного PATH в IDE cmd, netstat, chcp могут пропасть.
    $dirs = @(
        (Join-Path $env:SystemRoot 'System32'),
        (Join-Path $env:SystemRoot 'SysWOW64'),
        (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0')
    )
    foreach ($dir in $dirs) {
        if ((Test-Path -LiteralPath $dir) -and ($env:Path -notlike "*$dir*")) {
            $env:Path = "$dir;$env:Path"
        }
    }
}

function Enable-VtIfPossible {
    try {
        $sig = @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int n);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(System.IntPtr h, out uint m);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(System.IntPtr h, uint m);
'@
        $t = Add-Type -PassThru -Name "Con" -Namespace "N" -MemberDefinition $sig
        $h = [N.Con]::GetStdHandle(-11)
        [uint32]$m = 0
        [void][N.Con]::GetConsoleMode($h, [ref]$m)
        [void][N.Con]::SetConsoleMode($h, $m -bor 4)
    } catch { }
}

function Write-NeyraBanner {
    Write-Host ""
    $m = "Magenta"
    $c = "Cyan"
    Write-Host "  ███╗   ██╗███████╗██╗   ██╗██████╗  █████╗ " -ForegroundColor $m
    Write-Host "  ██╔██╗ ██║██╔════╝╚██╗ ██╔╝██╔══██╗██╔══██╗" -ForegroundColor $m
    Write-Host "  ██║╚██╗██║█████╗   ╚████╔╝ ██████╔╝███████║" -ForegroundColor $m
    Write-Host "  ██║ ╚████║██╔══╝    ╚██╔╝  ██╔══██╗██╔══██║" -ForegroundColor $m
    Write-Host "  ██║  ╚███║███████╗   ██║   ██║  ██║██║  ██║" -ForegroundColor $m
    Write-Host "  ╚═╝   ╚══╝╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝" -ForegroundColor $m
    Write-Host "           // neural stack · local-first" -ForegroundColor $c
    Write-Host ""
}

function Write-Ok($msg) { Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host "[ERR] $msg" -ForegroundColor Red }
function Write-Hi($msg) { Write-Host $msg -ForegroundColor Cyan }

function Get-JavaMajorVersion {
    if (-not (Get-Command java -ErrorAction SilentlyContinue)) { return $null }
    $oldEa = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = (& java -version 2>&1 | Select-Object -First 1)
    } finally {
        $ErrorActionPreference = $oldEa
    }
    if (-not $out) { return $null }
    if ($out -match '"(?<v>[\d\.]+)') {
        $v = $Matches['v']
        if ($v.StartsWith("1.")) {
            return [int]($v.Split(".")[1])
        }
        return [int]($v.Split(".")[0])
    }
    return $null
}

function Show-SystemDepsManualLinks {
    Write-Hi "Git: https://git-scm.com/"
    Write-Hi "FFmpeg: https://ffmpeg.org/download.html"
    Write-Hi "Java 17 (для Lavalink): https://adoptium.net/temurin/releases/?version=17"
    Write-Hi "Node.js (для dashboard): https://nodejs.org/"
    Write-Hi "Python 3.10+: https://www.python.org/downloads/"
}

function Get-NodeMajorVersion {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $null }
    $v = (& node -v 2>$null)
    if ($v -match '^v(?<maj>\d+)') { return [int]$Matches['maj'] }
    return $null
}

function Test-PythonRuntime310 {
    param([string]$Exe)
    if (-not $Exe) { return $false }
    $oldEa = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Exe -c "import sys; raise SystemExit(0 if sys.version_info>=(3,10) else 1)" *> $null
        return $LASTEXITCODE -eq 0
    } finally {
        $ErrorActionPreference = $oldEa
    }
}

function Sync-PathFromEnvironment {
    $machine = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    if ($machine -and $user) {
        $env:Path = "$machine;$user"
    } elseif ($machine) { $env:Path = $machine }
    elseif ($user) { $env:Path = $user }
}

function Resolve-LauncherPython {
    param([string]$RepoRoot)
    # Native Windows: .venv_win (отдельно от Linux/WSL .venv). Fallback: .venv\Scripts → PATH.
    $venvWin = Join-Path $RepoRoot '.venv_win\Scripts\python.exe'
    $venvLinuxTree = Join-Path $RepoRoot '.venv\Scripts\python.exe'
    if ((Test-Path -LiteralPath $venvWin) -and (Test-PythonRuntime310 -Exe $venvWin)) { return $venvWin }
    if ((Test-Path -LiteralPath $venvLinuxTree) -and (Test-PythonRuntime310 -Exe $venvLinuxTree)) {
        Write-Warn "Найден .venv\Scripts (часто от WSL/Linux). Для native Windows рекомендуется: py -3 -m venv .venv_win"
        return $venvLinuxTree
    }
    foreach ($name in @('python', 'python3')) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if (-not $cmd) { continue }
        $src = $cmd.Source
        if (Test-PythonRuntime310 -Exe $src) { return $src }
    }
    if (Get-Command py -ErrorAction SilentlyContinue) {
        $oldEa = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $out = & py -3 -c "import sys; print(sys.executable)" 2>$null
        } finally {
            $ErrorActionPreference = $oldEa
        }
        if ($LASTEXITCODE -eq 0 -and $out -and (Test-PythonRuntime310 -Exe $out.Trim())) {
            return $out.Trim()
        }
    }
    return $null
}

function Get-PythonInterpreterLabel {
    param([string]$ExePath)
    if (-not $ExePath) { return 'неизвестно' }
    $n = $ExePath -replace '\\', '/'
    if ($n -match '(?i)/\.venv_win/scripts/python\.exe$') { return 'локальный .venv_win (Windows)' }
    if ($n -match '(?i)/\.venv/scripts/python\.exe$') { return 'локальный .venv\Scripts (fallback / WSL-tree)' }
    if ($n -match '(?i)/\.venv/bin/python[0-9.]*$') { return 'локальный .venv (Unix/WSL)' }
    return 'глобальный / PATH / py (не venv репозитория)'
}

function Invoke-SystemDepsAutoInstall {
    param([string[]]$Missing)
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Warn "winget не найден — авто-установка недоступна."
        return
    }
    foreach ($dep in $Missing) {
        switch ($dep) {
            "git" {
                Write-Hi "Устанавливаю Git через winget..."
                & winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
            }
            "ffmpeg" {
                Write-Hi "Устанавливаю FFmpeg через winget..."
                & winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
            }
            "java" {
                Write-Hi "Устанавливаю Java 17 JRE через winget..."
                & winget install --id EclipseAdoptium.Temurin.17.JRE -e --accept-source-agreements --accept-package-agreements
            }
            "nodejs" {
                Write-Hi "Устанавливаю Node.js (LTS) через winget..."
                & winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
            }
            "npm" {
                Write-Hi "Ставлю Node.js (включает npm), если npm отдельно не найден..."
                & winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
            }
            "python" {
                Write-Hi "Устанавливаю Python 3.12 через winget..."
                & winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements
            }
        }
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "Не удалось установить: $dep"
        }
    }
}

function Invoke-dashboardNpmHeal {
    $fr = Join-Path $Root 'dashboard'
    $pkg = Join-Path $fr 'package.json'
    if (-not (Test-Path $pkg)) { return }
    Write-Hi "Проверяю dashboard (npm)..."
    if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Warn "Node.js/npm не в PATH — пропускаю dashboard (см. системные зависимости)."
        return
    }
    $nm = Join-Path $fr 'node_modules'
    if (-not (Test-Path $nm)) {
        Write-Warn "dashboard/node_modules отсутствует."
        $yn = Read-Host "Запустить npm ci в dashboard/? [y/N]"
        if ($yn -match '^[yY]') {
            Push-Location $fr
            try {
                & npm ci
                if ($LASTEXITCODE -ne 0) { & npm install }
            } finally {
                Pop-Location
            }
            if ($LASTEXITCODE -ne 0) { Write-Warn "npm ci/install завершился с ошибкой." }
            else { Write-Ok "Зависимости dashboard установлены." }
        }
    } else {
        Write-Ok "dashboard/node_modules на месте."
    }
}

function Ensure-ProjectVenv {
    $venvPy = Join-Path $Root '.venv_win\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $venvPy)) {
        Write-Warn "Создаю .venv_win (Windows venv; Linux/WSL использует отдельный .venv/bin)..."
        $venvPath = Join-Path $Root '.venv_win'
        $venvEc = Invoke-PythonModule -PythonArgs @('-m', 'venv', $venvPath)
        if ($venvEc -ne 0) {
            Write-Err "Не удалось создать .venv_win (проверь python-venv/pip)."
            return $false
        }
        if (-not (Test-Path -LiteralPath $venvPy)) {
            $boot = Join-Path $env:TEMP "neyra-get-pip.py"
            try {
                Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $boot -UseBasicParsing
                $null = Invoke-PythonModule -PythonArgs @($boot)
            } catch {
                Write-Warn "ensurepip/get-pip не сработал — попробуй pip вручную."
            } finally {
                Remove-Item -LiteralPath $boot -ErrorAction SilentlyContinue
            }
        }
    }
    $script:Py = $venvPy
    $script:Pip = "$($script:Py) -m pip"
    $pipUp = Invoke-PythonModule -PythonArgs @('-m', 'pip', 'install', '--upgrade', 'pip')
    if ($pipUp -ne 0) {
        Write-Warn "Не удалось обновить pip в .venv_win — продолжаю."
    }
    Write-Ok "Переключилась на .venv_win: $script:Py"
    return $true
}

# $PSScriptRoot empty when loaded via neyra_win_boot.ps1 (UTF-8 ScriptBlock).
$_launcherDir = if ($PSScriptRoot) {
    $PSScriptRoot
} elseif ($global:NeyraLauncherScriptRoot) {
    [string]$global:NeyraLauncherScriptRoot
} else {
    Split-Path -Parent $MyInvocation.MyCommand.Path
}
$Root = Split-Path -Parent $_launcherDir
Set-Location -LiteralPath $Root

Ensure-WindowsToolPath
Sync-PathFromEnvironment
Enable-VtIfPossible
# Python on Windows often prints UTF-8 while the console is OEM/ANSI → � / mojibake.
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'
try { & "$env:SystemRoot\System32\chcp.com" 65001 | Out-Null } catch { }

$Py = Resolve-LauncherPython -RepoRoot $Root
if (-not $Py) {
    Write-Err "Python 3.10+ не найден. Установи с python.org или через winget (Python.Python.3.12)."
    Show-SystemDepsManualLinks
    Read-Host "Enter для выхода"
    exit 1
}

$Pip = "$Py -m pip"
$LlHome = Join-Path $Root "modules\discord\lavalink"

$modules = @(
    "yaml", "dotenv", "requests", "httpx", "fastapi", "uvicorn", "discord", "wavelink", "PIL",
    "langchain", "langchain_openai", "langchain_community", "chromadb", "sentence_transformers", "apscheduler", "ddgs", "nacl"
)

function Test-PythonMod($name) {
    $oldEa = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Py -c "import $name" *> $null
        return $LASTEXITCODE -eq 0
    } finally {
        $ErrorActionPreference = $oldEa
    }
}

function Invoke-PythonModule {
    param(
        # Named parameter only — do NOT use ValueFromRemainingArguments + splat.
        # Splatting @('script.py', '--config', ...) makes PowerShell treat --config
        # as a function parameter and can glue all args into one bogus path.
        [Parameter(Mandatory = $true)]
        [string[]]$PythonArgs
    )
    # Important: Python stdout must NOT become the function's return value.
    # Otherwise `$ec = Invoke-PythonModule ...` gets Object[] (log lines + int),
    # and `if ($ec -ne 0)` is always true → false "fetch_lavalink failed" etc.
    $oldEa = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $exe = if ($script:Py) { $script:Py } else { $Py }
        & $exe @PythonArgs 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) {
                Write-Host $_.Exception.Message
            } else {
                Write-Host $_
            }
        }
        if ($null -ne $LASTEXITCODE) { return [int]$LASTEXITCODE }
        return 0
    } finally {
        $ErrorActionPreference = $oldEa
    }
}

function Show-HealthcheckFailure {
    param(
        [string]$LogPath,
        [int]$ExitCode,
        [string]$Mode,
        [switch]$SkipHttp
    )
    Write-Warn "Healthcheck FAIL (код выхода $ExitCode)."
    Write-Host ""
    if (Test-Path -LiteralPath $LogPath) {
        Get-Content -LiteralPath $LogPath -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
    }
    Write-Host ""
    Write-Hi "Что проверить:"
    $hcCmd = "`"$Py`" scripts\healthcheck.py --mode $Mode"
    if ($SkipHttp) { $hcCmd += ' --skip-http' }
    Write-Host "  1) Повтор вручную: $hcCmd"
    Write-Host "  2) Секреты: .env (OPENROUTER_API_KEY; core+Discord — DISCORD_TOKEN)"
    Write-Host "  3) Конфиг: config.yaml, modules\discord\plugin.yaml"
    Write-Host "  4) Лог ядра: $(Join-Path $Root 'logs\system.log')"
    Write-Host ""
    Write-Hi "PATH: если в логе «chcp/netstat не является командой» — добавь %SystemRoot%\System32 в PATH пользователя Windows."
}

function Invoke-NeyraHealthcheck {
    param(
        [string]$Mode = 'console',
        [switch]$SkipHttp
    )
    $hcScript = Join-Path $Root 'scripts\healthcheck.py'
    $log = Join-Path $env:TEMP ("neyra-healthcheck-{0}.log" -f [guid]::NewGuid().ToString('n'))
    $pyArgs = @($hcScript, '--mode', $Mode)
    if ($SkipHttp) { $pyArgs += '--skip-http' }
    $oldEa = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $Py @pyArgs 2>&1
        $ec = [int]$LASTEXITCODE
        if ($null -eq $ec) { $ec = 1 }
        $output | ForEach-Object { Write-Host $_ }
        $output | Out-File -LiteralPath $log -Encoding utf8
    } finally {
        $ErrorActionPreference = $oldEa
    }
    if ($ec -eq 0) { return 0 }
    Show-HealthcheckFailure -LogPath $log -ExitCode $ec -Mode $Mode -SkipHttp:$SkipHttp
    return $ec
}

function Invoke-Preflight {
    Write-NeyraBanner
    Write-Hi "Инициализация системных модулей... сканирую окружение, босс."
    Write-Host ""

    Write-Hi "Проверка: git, ffmpeg, Java, Node.js, npm, Python 3.10+..."
    $miss = @()
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { $miss += "git" }
    if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { $miss += "ffmpeg" }
    if (-not (Get-Command java -ErrorAction SilentlyContinue)) { $miss += "java" }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { $miss += "nodejs" }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { $miss += "npm" }
    if (-not (Test-PythonRuntime310 -Exe $Py)) { $miss += "python" }

    if ($miss.Count -gt 0) {
        Write-Warn "Отсутствуют или не подходят зависимости: $($miss -join ', ')"
        $sysInstall = Read-Host "Попытаться установить/починить автоматически? [y/N]"
        if ($sysInstall -match '^[yY]') {
            Invoke-SystemDepsAutoInstall -Missing $miss
            Sync-PathFromEnvironment
            $newPy = Resolve-LauncherPython -RepoRoot $Root
            if ($newPy) {
                $script:Py = $newPy
                $script:Pip = "$($script:Py) -m pip"
            }
        }

        $miss2 = @()
        if (-not (Get-Command git -ErrorAction SilentlyContinue)) { $miss2 += "git" }
        if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { $miss2 += "ffmpeg" }
        if (-not (Get-Command java -ErrorAction SilentlyContinue)) { $miss2 += "java" }
        if (-not (Get-Command node -ErrorAction SilentlyContinue)) { $miss2 += "nodejs" }
        if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { $miss2 += "npm" }
        if (-not (Test-PythonRuntime310 -Exe $Py)) { $miss2 += "python" }
        if ($miss2.Count -gt 0) {
            Write-Warn "Все еще проблемы: $($miss2 -join ', ')"
            Show-SystemDepsManualLinks
        } elseif ($miss.Count -gt 0) {
            Write-Ok "Системный стек установлен / исправлен."
        }
    } else {
        Write-Ok "Системные утилиты и Python в порядке."
    }

    if (-not (Test-PythonRuntime310 -Exe $Py)) {
        Write-Err "Нужен Python 3.10+ (сейчас: $Py). Перезапусти терминал после установки или проверь PATH."
        Show-SystemDepsManualLinks
        Read-Host "Enter для выхода"
        exit 1
    }

    $javaMajor = Get-JavaMajorVersion
    if ($null -ne $javaMajor) {
        if ($javaMajor -lt 11) {
            Write-Warn "Найдена Java $javaMajor. Для Lavalink v4 нужна Java 11+, рекомендуется 17."
            Show-SystemDepsManualLinks
        } elseif ($javaMajor -lt 17) {
            Write-Warn "Найдена Java $javaMajor. Работать может, но рекомендуется Java 17."
        } else {
            Write-Ok "Java версии $javaMajor — отлично для Lavalink."
        }
    }

    $nodeMajor = Get-NodeMajorVersion
    if ($null -ne $nodeMajor) {
        if ($nodeMajor -lt 18) {
            Write-Warn "Node.js major=${nodeMajor}: для Vite 8 (dashboard) обычно нужен Node 18+."
        } else {
            Write-Ok "Node.js major=${nodeMajor} — подходит для dev/build фронтенда."
        }
    }
    Write-Host ""

    $venvBinPy = Join-Path $Root '.venv\bin\python'
    $venvWinPy = Join-Path $Root '.venv_win\Scripts\python.exe'
    if ($env:OS -like '*Windows*') {
        if ((Test-Path -LiteralPath $venvBinPy) -and -not (Test-Path -LiteralPath $venvWinPy)) {
            Write-Warn "Есть Linux/WSL venv (.venv\bin), но нет .venv_win — для Windows: py -3 -m venv .venv_win"
        }
    }
    Write-Ok "Интерпретатор Python: $Py — $(Get-PythonInterpreterLabel -ExePath $Py)"

    Write-Hi "Проверяю Python-модули..."
    $bad = @()
    foreach ($m in $modules) {
        if (-not (Test-PythonMod $m)) { $bad += $m }
    }
    if ($bad.Count -gt 0) {
        Write-Warn "Не хватает: $($bad -join ' ')"
        $yn = Read-Host "Нейра: поставить зависимости из requirements.txt сейчас? [y/N]"
        if ($yn -match '^[yY]') {
            $reqFile = Join-Path $Root "requirements.txt"
            Write-Hi "pip install (может занять время, лог в консоли)..."
            $pipEc = Invoke-PythonModule -PythonArgs @('-m', 'pip', 'install', '-r', $reqFile)
            if ($pipEc -ne 0) {
                $pipLog = Join-Path $env:TEMP ("neyra-pip-{0}.log" -f [guid]::NewGuid().ToString('n'))
                $pipProc = Start-Process -FilePath $Py -ArgumentList @('-m', 'pip', 'install', '-r', $reqFile) `
                    -RedirectStandardOutput $pipLog -RedirectStandardError $pipLog -Wait -PassThru -NoNewWindow
                $joined = ''
                if (Test-Path -LiteralPath $pipLog) {
                    $joined = Get-Content -LiteralPath $pipLog -Raw -ErrorAction SilentlyContinue
                }
                if ($pipProc.ExitCode -ne 0 -and $joined -match "externally-managed-environment|PEP 668") {
                    Write-Warn "PEP 668 / externally managed окружение. Перехожу на локальный .venv_win..."
                    if (-not (Ensure-ProjectVenv)) {
                        Write-Err "Не удалось авто-починить Python-окружение."
                        Read-Host "Enter для выхода"
                        exit 1
                    }
                    $pipEc2 = Invoke-PythonModule -PythonArgs @('-m', 'pip', 'install', '-r', $reqFile)
                    if ($pipEc2 -ne 0) {
                        Write-Err "pip install в .venv_win провалился."
                        Read-Host "Enter для выхода"
                        exit 1
                    }
                } else {
                    Write-Err "pip install провалился."
                    if ($joined) { Write-Host $joined }
                    Read-Host "Enter для выхода"
                    exit 1
                }
            }
            $bad2 = @()
            foreach ($m in $modules) {
                if (-not (Test-PythonMod $m)) { $bad2 += $m }
            }
            if ($bad2.Count -gt 0) {
                Write-Err "После установки всё ещё не хватает: $($bad2 -join ' ')"
                Read-Host "Enter для выхода"
                exit 1
            }
            Write-Ok "Зависимости подтянуты."
        } else {
            Write-Err "Без модулей я не запущу ядро."
            Read-Host "Enter для выхода"
            exit 1
        }
    } else {
        Write-Ok "Все нужные модули на борту."
    }
    Write-Host ""

    Invoke-dashboardNpmHeal

    Write-Host ""
    Write-Hi "Healthcheck (console)..."
    $hcEc = Invoke-NeyraHealthcheck -Mode console -SkipHttp
    if ($hcEc -ne 0) {
        Write-Warn "Healthcheck не прошёл — см. причины выше."
        $c = Read-Host "Продолжить всё равно? [y/N]"
        if ($c -notmatch '^[yY]') { exit 0 }
    } else {
        Write-Ok "Healthcheck: ок."
    }

    Write-Host ""
    Write-Hi "Voice preflight (STT/TTS — soft only, ядро не блокируем)..."
    $voiceEc = Invoke-PythonModule -PythonArgs @((Join-Path $Root 'scripts\voice_preflight.py'))
    if ($voiceEc -ne 0) {
        Write-Warn "Voice preflight вернул код $voiceEc (ядро всё равно можно стартовать)."
    }

    Write-Hi "Нейра готова к запуску. Что будем делать дальше, босс?"
    Write-Host ""
}

function Ensure-LavalinkConfig {
    $yml = Join-Path $LlHome "application.yml"
    $ex = Join-Path $LlHome "application.example.yml"
    if (-not (Test-Path $yml) -and (Test-Path $ex)) {
        Copy-Item $ex $yml -Force
        Write-Ok "Создала application.yml из примера."
    }
}

function Start-LavalinkIfPossible {
    $jar = Join-Path $LlHome "Lavalink.jar"
    if (-not (Test-Path $jar)) {
        Write-Warn "Lavalink.jar не найден. Пункт 4 меню или: $Py scripts\fetch_lavalink.py"
        return
    }
    Ensure-LavalinkConfig
    $sz = (Get-Item $jar).Length
    if ($sz -lt 1048576) {
        Write-Warn "JAR слишком маленький ($sz B) — похоже на LFS pointer. Пункт 4."
        return
    }
    $procs = Get-CimInstance Win32_Process -Filter "Name='java.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*Lavalink.jar*' }
    if ($procs) {
        Write-Ok "Lavalink уже в фоне."
        return
    }
    $lavCfg = Join-Path $LlHome 'application.yml'
    $plugEc = Invoke-PythonModule -PythonArgs @(
        (Join-Path $Root 'scripts\fetch_lavalink_plugins.py'),
        '--config', $lavCfg,
        '--latest-youtube'
    )
    if ($plugEc -ne 0) {
        Write-Warn "Плагины Lavalink не готовы (часто Git LFS pointer). Пункт 4 меню или: $Py scripts\fetch_lavalink_plugins.py"
        return
    }
    Start-Process -FilePath "java" -ArgumentList @("-Dfile.encoding=UTF-8", "-jar", "Lavalink.jar") `
        -WorkingDirectory $LlHome -WindowStyle Minimized
    Start-Sleep -Seconds 2
    Write-Ok "Lavalink стартовал (или уже был онлайн)."
}

Invoke-Preflight

while ($true) {
    Write-NeyraBanner
    Write-Hi "--- главное меню ---"
    Write-Host "  1) Консоль — только диалог с моделью [без HTTP]"
    Write-Host "  2) Полное ядро — API, dashboard, плагины (спрошу про Lavalink)"
    Write-Host "  3) Только Lavalink — фоновый процесс"
    Write-Host "  4) Починить Lavalink.jar + плагины — fetch_lavalink*.py"
    Write-Host "  5) Повторить проверки зависимостей"
    Write-Host "  6) Выход"
    Write-Host ""
    $choice = Read-Host "Твой выбор [1-6]"

    switch ($choice) {
        "1" {
            Write-Ok "Запускаю консольный режим. Удачного диалога."
            $null = Invoke-PythonModule -PythonArgs @((Join-Path $Root "main.py"), '--mode', 'console')
            Write-Hi "Консоль завершилась. Возвращаюсь в меню."
        }
        "2" {
            Write-Hi "Прогоняю healthcheck для core..."
            $coreHc = Invoke-NeyraHealthcheck -Mode core -SkipHttp
            if ($coreHc -ne 0) {
                Write-Warn "Healthcheck core не идеален — всё равно стартовать?"
                $cc = Read-Host "Продолжить? [y/N]"
                if ($cc -notmatch '^[yY]') { continue }
            }
            Write-Host ""
            $la = Read-Host "Запустить Lavalink автоматически перед ядром? [y/N]"
            if ($la -match '^[yY]') { Start-LavalinkIfPossible }
            else { Write-Hi "Ок, Lavalink не трогаю — поднимай сам (п.3) или оставь уже запущенный." }
            Write-Ok "Стартую ядро: main.py --mode core"
            $coreEc = Invoke-PythonModule -PythonArgs @((Join-Path $Root "main.py"), '--mode', 'core')
            if ($coreEc -ne 0) {
                Write-Warn "Ядро завершилось с кодом $coreEc (часто бывает при падении torch/OpenMP или нехватке RAM — см. консоль и logs/system.log)."
            }
            Write-Hi "Ядро остановилось. Окно можно закрыть или выбрать режим снова."
        }
        "3" {
            Write-Hi "Поднимаю Lavalink отдельно..."
            Start-LavalinkIfPossible
        }
        "4" {
            Write-Hi "Качаю Lavalink.jar и JAR-плагины..."
            $f1 = Invoke-PythonModule -PythonArgs @((Join-Path $Root "scripts\fetch_lavalink.py"))
            if ($f1 -ne 0) { Write-Err "fetch_lavalink.py завершился с ошибкой." }
            else {
                $f2 = Invoke-PythonModule -PythonArgs @(
                    (Join-Path $Root "scripts\fetch_lavalink_plugins.py"),
                    '--config', (Join-Path $Root "modules\discord\lavalink\application.yml"),
                    '--latest-youtube'
                )
                if ($f2 -ne 0) { Write-Err "fetch_lavalink_plugins.py завершился с ошибкой." }
                else { Write-Ok "Готово. Можно пункт 3 или 2." }
            }
        }
        "5" { Invoke-Preflight }
        "6" {
            Write-Hi "Увидимся, босс."
            exit 0
        }
        Default {
            Write-Warn "Такого пункта нет. Попробуй ещё раз."
        }
    }
}
