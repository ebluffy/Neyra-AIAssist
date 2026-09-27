# Neyra Windows bootstrap (ASCII-only).
# PowerShell 5.1 -File mis-parses UTF-8 Cyrillic if the .ps1 lost its BOM (editors often strip it).
# This loader always reads neyra_win_launcher.ps1 as UTF-8 and invokes it.
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
if (-not $scriptDir) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$main = Join-Path $scriptDir 'neyra_win_launcher.ps1'
if (-not (Test-Path -LiteralPath $main)) {
    Write-Host "[ERR] Missing launcher: $main"
    exit 1
}

$utf8 = New-Object System.Text.UTF8Encoding $false
$bytes = [System.IO.File]::ReadAllBytes($main)
$offset = 0
if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    $offset = 3
}
$code = $utf8.GetString($bytes, $offset, $bytes.Length - $offset)

$parseErrors = $null
$tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($code, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors -and $parseErrors.Count -gt 0) {
    Write-Host '[ERR] neyra_win_launcher.ps1 parse failed (encoding/syntax):'
    foreach ($e in $parseErrors) { Write-Host ("  " + $e.ToString()) }
    exit 1
}

# Nested ScriptBlock has empty $PSScriptRoot — pass dir via global for the launcher.
$global:NeyraLauncherScriptRoot = $scriptDir
& $ast.GetScriptBlock()
exit $LASTEXITCODE
