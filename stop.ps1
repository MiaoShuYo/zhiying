$ErrorActionPreference = 'Stop'
$statePath = Join-Path $PSScriptRoot 'data\runtime\services.json'
if (-not (Test-Path -LiteralPath $statePath)) {
  Write-Host '没有由 start.ps1 启动的服务。'
  exit 0
}

$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
foreach ($name in @('web', 'python')) {
  $entry = $state.$name
  if ($null -eq $entry) { continue }
  try {
    $process = Get-Process -Id ([int]$entry.id) -ErrorAction Stop
    if ($process.StartTime.ToFileTimeUtc() -ne [long]$entry.startFileTime) {
      Write-Warning "已跳过 PID $($entry.id)：进程身份已变化。"
      continue
    }
    & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
    Write-Host "已停止 $name 服务。"
  } catch { Write-Host "$name 服务已经退出。" }
}
Remove-Item -LiteralPath $statePath -Force

foreach ($port in 8000, 3000) {
  try {
    $connection = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $connection) { continue }
    $owner = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
    $label = if ($owner) { "$($owner.ProcessName) (PID $($owner.Id))" } else { "PID $($connection.OwningProcess)" }
    Write-Warning "端口 $port 仍被 $label 占用；它不是 start.ps1 启动的，请手动结束后再启动。"
  } catch { }
}
