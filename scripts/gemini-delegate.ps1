# gemini-delegate.ps1 - Claude Code から Gemini CLI にタスクを委譲するラッパー
# 使い方: .\scripts\gemini-delegate.ps1 -Task "最新のNext.jsベストプラクティス調査" -Mode research
# 環境変数: GEMINI_MODEL / GEMINI_FALLBACK_MODEL / GEMINI_WORKDIR / GEMINI_MAX_OUTPUT_CHARS

param(
    [Parameter(Mandatory=$true)]
    [string]$Task,

    [ValidateSet("research", "implement", "review", "refactor", "testfix")]
    [string]$Mode = "research",

    [string[]]$Targets = @(),

    [string[]]$Constraints = @()
)

$ErrorActionPreference = "SilentlyContinue"

# --- 設定（環境変数で上書き可能） ---
$Model          = if ($env:GEMINI_MODEL)            { $env:GEMINI_MODEL }            else { "gemini-3.1-pro-preview" }
$FallbackModel  = if ($env:GEMINI_FALLBACK_MODEL)   { $env:GEMINI_FALLBACK_MODEL }   else { "gemini-3-flash-preview" }
$WorkDir        = if ($env:GEMINI_WORKDIR)           { $env:GEMINI_WORKDIR }          else { (Get-Location).Path }
$MaxChars       = if ($env:GEMINI_MAX_OUTPUT_CHARS)  { [int]$env:GEMINI_MAX_OUTPUT_CHARS } else { 6000 }

# --- モード別 承認モード ---
$readOnlyModes = @("research", "review")
$ApprovalMode  = if ($readOnlyModes -contains $Mode) { "plan" } else { "yolo" }

# --- プロンプト構築 ---
$lines = @(
    "mode: $Mode",
    "task: $Task"
)
if ($Targets.Count -gt 0)     { $lines += "targets: $($Targets -join ', ')" }
if ($Constraints.Count -gt 0) { $lines += "constraints: $($Constraints -join ', ')" }
$lines += ""
$lines += 'Return JSON only (no markdown): {"summary":"...","changed_files":["..."],"verification":"...","risks":["..."]}'

$prompt = $lines -join "`n"

# --- Gemini 実行関数 ---
function Invoke-Gemini {
    param(
        [string]$UseModel,
        [string]$Prompt,
        [string]$Approval,
        [string]$Dir
    )

    $geminiArgs = @(
        "-p", $Prompt,
        "-m", $UseModel,
        "--approval-mode", $Approval,
        "-o", "json"
    )

    Write-Host "[gemini-delegate] model=$UseModel  mode=$Mode  approval=$Approval" -ForegroundColor DarkMagenta
    Write-Host "[gemini-delegate] task: $Task" -ForegroundColor DarkMagenta

    $result = $null
    $exitCode = 0

    try {
        Push-Location $Dir
        $result = & gemini @geminiArgs 2>&1
        $exitCode = $LASTEXITCODE
    } catch {
        $exitCode = 1
        $result = $_.Exception.Message
    } finally {
        Pop-Location
    }

    return @{
        Output   = ($result | Out-String)
        ExitCode = $exitCode
    }
}

# --- メインモデルで実行 ---
$run = Invoke-Gemini -UseModel $Model -Prompt $prompt -Approval $ApprovalMode -Dir $WorkDir

# --- フォールバック ---
if ($run.ExitCode -ne 0 -and $FallbackModel -ne $Model) {
    Write-Host "[gemini-delegate] primary model failed, falling back to $FallbackModel" -ForegroundColor Yellow
    $run = Invoke-Gemini -UseModel $FallbackModel -Prompt $prompt -Approval $ApprovalMode -Dir $WorkDir
}

# --- 結果が失敗のまま ---
if ($run.ExitCode -ne 0) {
    @{
        ok         = $false
        error      = "Gemini execution failed"
        summary    = ""
        changed_files = @()
        verification  = ""
        risks         = @()
        raw_output    = $run.Output
    } | ConvertTo-Json -Compress | Write-Output
    exit 1
}

# --- 出力パース ---
$raw = $run.Output

$rawTrimmed = if ($raw -and $raw.Length -gt $MaxChars) {
    $raw.Substring(0, $MaxChars) + "`n...[truncated]"
} else { $raw }

# --- Gemini JSON出力からresponseフィールドを抽出 ---
try {
    $geminiJson = $raw | ConvertFrom-Json -ErrorAction Stop

    # Gemini CLIの -o json は { session_id, response, stats } を返す
    $responseText = if ($geminiJson.response) { $geminiJson.response } else { $raw }

    # response内のJSONをパース
    try {
        $p = $responseText | ConvertFrom-Json -ErrorAction Stop
        @{
            ok            = $true
            summary       = "$($p.summary)"
            changed_files = @($p.changed_files)
            verification  = "$($p.verification)"
            risks         = @($p.risks)
            raw_output    = $rawTrimmed
        } | ConvertTo-Json -Compress -Depth 10 | Write-Output
    } catch {
        # responseがプレーンテキストの場合
        @{
            ok            = $true
            summary       = "$responseText"
            changed_files = @()
            verification  = ""
            risks         = @()
            raw_output    = $rawTrimmed
        } | ConvertTo-Json -Compress -Depth 10 | Write-Output
    }
} catch {
    # Gemini出力がJSONじゃない場合
    @{
        ok            = $true
        summary       = $rawTrimmed
        changed_files = @()
        verification  = ""
        risks         = @()
        raw_output    = $rawTrimmed
    } | ConvertTo-Json -Compress -Depth 10 | Write-Output
}
