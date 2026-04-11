<#
.SYNOPSIS
    ThreadsOS ハートビートを Windows タスクスケジューラに登録する。

.DESCRIPTION
    pm2 が使えない環境向けのフォールバック。
    毎時 0 分に hourly-heartbeat.ts を実行するタスクを登録する。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\setup-scheduler.ps1

.NOTES
    管理者権限不要（Current User スコープで登録）。
    pm2 が使える場合は pm2 + ecosystem.config.cjs を推奨。
#>

param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$TaskName = "ThreadsOS-Heartbeat",
    [switch]$Remove
)

$ErrorActionPreference = "Stop"

# ── 削除モード ────────────────────────────────────────────────────────
if ($Remove) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "タスク '$TaskName' を削除しました。"
    exit 0
}

# ── pnpm のパスを取得 ─────────────────────────────────────────────────
$pnpmPath = (Get-Command pnpm -ErrorAction SilentlyContinue)?.Source
if (-not $pnpmPath) {
    # nvm / volta 経由の場合に備えてフルパスを探す
    $pnpmPath = "$env:APPDATA\npm\pnpm.cmd"
    if (-not (Test-Path $pnpmPath)) {
        Write-Error "pnpm が見つかりません。先に pnpm をインストールしてください。"
        exit 1
    }
}

# ── タスク設定 ────────────────────────────────────────────────────────
$action = New-ScheduledTaskAction `
    -Execute $pnpmPath `
    -Argument "job:heartbeat" `
    -WorkingDirectory $ProjectRoot

# 毎時 0 分に繰り返し実行
$trigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Hours 1) -Once -At "00:00"

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 50) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -RunLevel Limited `
    -Force | Out-Null

Write-Host "✓ タスク '$TaskName' を登録しました（毎時 0 分に自動実行）。"
Write-Host ""
Write-Host "確認: Get-ScheduledTask -TaskName '$TaskName'"
Write-Host "削除: powershell -File scripts\setup-scheduler.ps1 -Remove"
