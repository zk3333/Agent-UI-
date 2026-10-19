<#
  轮询 run.log，直到出现 RC= 标记（测试结束）或超时，并持续输出心跳日志。
  背景：run-test.ps1 在后台跑 Playwright（单条用例约 4 分钟），前台若静默轮询，
        期间无法判断「在跑 / 卡住 / 已结束」。本脚本每 HeartbeatSec 打一行进度。

  用法：
    powershell -NoProfile -File poll-test.ps1
    powershell -NoProfile -File poll-test.ps1 -LogFile run.log -TimeoutSec 2400 -HeartbeatSec 20
#>
param(
  [string]$LogFile   = 'run.log',
  [int]$TimeoutSec   = 2400,
  [int]$IntervalSec  = 5,
  [int]$HeartbeatSec = 20
)

$ErrorActionPreference = 'Continue'

# run.log 由 run-test.ps1 的重定向写入，Windows PowerShell 5.1 默认写 UTF-16LE(BOM)。
# 这里按 BOM 自适应解码，避免中文步骤标题显示成乱码。
# 关键：run.log 被写进程（npx playwright test *> run.log）独占锁定，
# [IO.File]::ReadAllBytes 会抛 IOException 被静默吞掉 → 心跳永远显示"暂无内容"。
# 改用 FileStream + FileShare.ReadWrite 共享模式读取被锁定的文件。
function Read-LogText([string]$path) {
  if (-not (Test-Path $path)) { return '' }
  $bytes = $null
  try {
    $fs = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
      $ms = New-Object IO.MemoryStream
      $fs.CopyTo($ms)
      $bytes = $ms.ToArray()
    } finally { $fs.Close() }
  } catch { return '' }
  $n = $bytes.Length
  if ($n -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) { return [Text.Encoding]::Unicode.GetString($bytes, 2, $n - 2) }
  if ($n -ge 2 -and $bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF) { return [Text.Encoding]::BigEndianUnicode.GetString($bytes, 2, $n - 2) }
  if ($n -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { return [Text.Encoding]::UTF8.GetString($bytes, 3, $n - 3) }
  return [Text.Encoding]::UTF8.GetString($bytes)
}

function Get-TailText([string]$text, [int]$count) {
  if (-not $text) { return '' }
  $lines = $text -split "`r?`n"
  return (($lines | Select-Object -Last $count) -join [Environment]::NewLine)
}

$start      = Get-Date
$deadline   = $start.AddSeconds($TimeoutSec)
$prevSize   = -1
$lastGrowth = $start
$lastBeat   = $start.AddSeconds(-$HeartbeatSec)   # 首轮立即打一条心跳
$ansi       = "$([char]27)\[[0-9;]*[A-Za-z]"
$rc         = $null
$raw        = ''

Write-Host ("[poll] {0} 开始轮询 {1}（超时 {2}s / 检查间隔 {3}s / 心跳 {4}s）" -f `
  $start.ToString('HH:mm:ss'), $LogFile, $TimeoutSec, $IntervalSec, $HeartbeatSec)

while ((Get-Date) -lt $deadline) {
  $now  = Get-Date
  $size = 0

  if (Test-Path $LogFile) {
    try { $size = (Get-Item $LogFile).Length } catch { $size = 0 }
    $raw = Read-LogText $LogFile
  }

  # ── 结束标记：RC=<code> ──
  if ($raw -match 'RC=(\d+)') { $rc = $Matches[1]; break }

  # ── 日志增长统计 ──
  $delta = if ($prevSize -lt 0) { 0 } else { $size - $prevSize }
  if ($delta -ne 0) { $lastGrowth = $now }
  $prevSize = $size

  # ── 心跳 ──
  if (($now - $lastBeat).TotalSeconds -ge $HeartbeatSec) {
    $lastBeat = $now
    $elapsed  = $now - $start

    $total = 0
    if ($raw -match 'Running (\d+) test') { $total = [int]$Matches[1] }
    $done = ([regex]::Matches($raw, '(?m)^\s*(?:ok|x|✓|✘)\s+\d+')).Count
    $prog = if ($total -gt 0) { "$done/$total" } else { '-' }

    $stage = if ($raw -match '\d+ (passed|failed)') { '收尾' }
             elseif ($total -gt 0) { '执行中' }
             else { '启动中' }

    $idle    = [int]($now - $lastGrowth).TotalSeconds
    $idleTag = if ($idle -ge 120) { "  [WARN ${idle}s 无新增输出]" } else { '' }

    $lines = @($raw -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
    $last  = if ($lines.Count -gt 0) { ($lines[-1] -replace $ansi, '').Trim() } else { '(日志暂无内容)' }
    if ($last.Length -gt 100) { $last = $last.Substring(0, 100) + '...' }

    Write-Host ("[poll] {0}  {1}  日志 {2:N1}KB({3:+0.0;-0.0;0.0}KB)  进度 {4}  {5}{6}  末行: {7}" -f `
      $now.ToString('HH:mm:ss'), $elapsed.ToString('hh\:mm\:ss'), ($size / 1KB), ($delta / 1KB), $prog, $stage, $idleTag, $last)
  }

  Start-Sleep -Seconds $IntervalSec
}

if ($null -ne $rc) {
  $elapsed = (Get-Date) - $start
  Write-Host ("[poll] {0}  检测到 RC={1}，总耗时 {2}" -f `
    (Get-Date).ToString('HH:mm:ss'), $rc, $elapsed.ToString('hh\:mm\:ss'))
  Write-Host "===== RUN LOG TAIL ====="
  Write-Host (Get-TailText $raw 45)
  exit 0
}

Write-Host ("[poll] {0}  超时 {1}s 仍未检测到 RC=，测试可能卡住" -f `
  (Get-Date).ToString('HH:mm:ss'), $TimeoutSec)
Write-Host "===== TIMEOUT, LOG TAIL ====="
Write-Host (Get-TailText (Read-LogText $LogFile) 45)
exit 1
