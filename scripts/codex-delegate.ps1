# codex-delegate.ps1 - Claude Code から Codex CLI にタスクを委譲するラッパー
# 使い方: .\scripts\codex-delegate.ps1 -Task "TODOコメント一覧" -Mode research
# 環境変数: CODEX_MODEL / CODEX_WORKDIR / CODEX_MAX_OUTPUT_CHARS / CODEX_DISABLE_EPHEMERAL

param(
    [Parameter(Mandatory=$true)]
    [string]$Task,

    [ValidateSet("research", "implement", "review", "refactor", "testfix")]
    [string]$Mode = "implement",

    [string[]]$Targets = @(),

    [string[]]$Constraints = @()
)

$ErrorActionPreference = "SilentlyContinue"

# --- 設定（環境変数で上書き可能） ---
$Model     = if ($env:CODEX_MODEL)            { $env:CODEX_MODEL }                    else { "gpt-5.4-mini" }
$WorkDir   = if ($env:CODEX_WORKDIR)          { $env:CODEX_WORKDIR }                  else { (Get-Location).Path }
$MaxChars  = if ($env:CODEX_MAX_OUTPUT_CHARS) { [int]$env:CODEX_MAX_OUTPUT_CHARS }    else { 6000 }
$Ephemeral = $env:CODEX_DISABLE_EPHEMERAL -ne "1"

# --- プロンプト構築（最小限） ---
$lines = @(
    "mode: $Mode",
    "task: $Task"
)
if ($Targets.Count -gt 0)     { $lines += "targets: $($Targets -join ', ')" }
if ($Constraints.Count -gt 0) { $lines += "constraints: $($Constraints -join ', ')" }
$lines += ""
$lines += 'Return JSON only (no markdown): {"summary":"...","changed_files":["..."],"verification":"...","risks":["..."]}'

$prompt = $lines -join "`n"

# --- 出力先一時ファイル ---
$outFile = Join-Path $env:TEMP "codex-out-$(Get-Date -Format 'yyyyMMddHHmmss').txt"

# --- mode別 サブエージェント設定 ---
# research/review → 軽量（サブエージェント不要）
# implement/refactor/testfix → enable_fanout で並列サブエージェント
$heavyModes = @("implement", "refactor", "testfix")
$useFanout  = $heavyModes -contains $Mode

# --- Codex 実行 ---
$codexArgs = @(
    "exec", $prompt,
    "--model",  $Model,
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "-C",       $WorkDir,
    "-o",       $outFile
)
if ($useFanout)  { $codexArgs += "--enable", "enable_fanout" }
if ($Ephemeral)  { $codexArgs += "--ephemeral" }

Write-Host "[codex-delegate] fanout=$(if($useFanout){'ON'}else{'OFF'})" -ForegroundColor DarkCyan

Write-Host "[codex-delegate] model=$Model  mode=$Mode" -ForegroundColor DarkCyan
Write-Host "[codex-delegate] task: $Task"              -ForegroundColor DarkCyan

try {
    & codex @codexArgs 2>&1 | ForEach-Object {
        # progress行はグレー表示、結果行は捨てる
        if ($_ -is [string]) { Write-Host "  $_" -ForegroundColor DarkGray }
    }
} catch {
    @{ ok=$false; error=$_.Exception.Message; summary=""; changed_files=@(); verification=""; risks=@(); raw_output="" } |
        ConvertTo-Json -Compress | Write-Output
    exit 1
}

# --- 結果読み取り ---
if (-not (Test-Path $outFile)) {
    @{ ok=$false; error="Codex output file not found"; summary=""; changed_files=@(); verification=""; risks=@(); raw_output="" } |
        ConvertTo-Json -Compress | Write-Output
    exit 1
}

$raw = Get-Content $outFile -Raw -ErrorAction SilentlyContinue
Remove-Item $outFile -ErrorAction SilentlyContinue

$rawTrimmed = if ($raw -and $raw.Length -gt $MaxChars) {
    $raw.Substring(0, $MaxChars) + "`n...[truncated]"
} else { $raw }

# --- JSONパース or rawそのまま ---
try {
    $p = $raw | ConvertFrom-Json -ErrorAction Stop
    @{
        ok            = $true
        summary       = "$($p.summary)"
        changed_files = @($p.changed_files)
        verification  = "$($p.verification)"
        risks         = @($p.risks)
        raw_output    = $rawTrimmed
    } | ConvertTo-Json -Compress -Depth 10 | Write-Output
} catch {
    @{
        ok            = $true
        summary       = $rawTrimmed
        changed_files = @()
        verification  = ""
        risks         = @()
        raw_output    = $rawTrimmed
    } | ConvertTo-Json -Compress -Depth 10 | Write-Output
}
