param(
  [string]$FFmpegBin = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot
$pythonRoot = Join-Path $repoRoot 'services\python'
$pythonExe = Join-Path $pythonRoot '.venv\Scripts\python.exe'
$stateDir = Join-Path $repoRoot 'data\runtime'
$statePath = Join-Path $stateDir 'services.json'
$logDir = Join-Path $repoRoot 'logs'

function Test-Port([int]$port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $pending = $client.BeginConnect('127.0.0.1', $port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(500)) { return $false }
    $client.EndConnect($pending)
    return $true
  } catch { return $false }
  finally { $client.Dispose() }
}

function Test-ManagedProcess($entry) {
  if ($null -eq $entry) { return $false }
  try {
    $process = Get-Process -Id ([int]$entry.id) -ErrorAction Stop
    return $process.StartTime.ToFileTimeUtc() -eq [long]$entry.startFileTime
  } catch { return $false }
}

function Wait-Service([string]$url, [int]$port, [int]$seconds, $process) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if ($process.HasExited) { throw "服务进程提前退出：$url" }
    if (Test-Port $port) {
      try {
        $response = Invoke-WebRequest -Uri $url -TimeoutSec 8 -UseBasicParsing
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return }
      } catch { }
    }
    Start-Sleep -Milliseconds 800
  }
  throw "等待服务启动超时：$url"
}

if (Test-Path -LiteralPath $statePath) {
  $oldState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  $pythonAlive = Test-ManagedProcess $oldState.python
  $webAlive = Test-ManagedProcess $oldState.web
  if ($pythonAlive -and $webAlive -and (Test-Port 8000) -and (Test-Port 3000)) {
    Write-Host '服务已运行：http://127.0.0.1:3000'
    Write-Host '停止命令：.\stop.ps1'
    exit 0
  }
  if ($pythonAlive -or $webAlive) { throw '上次启动的服务仍有进程在运行。请先执行 .\stop.ps1，再重新启动。' }
  Remove-Item -LiteralPath $statePath -Force
}

if ((Test-Port 8000) -or (Test-Port 3000)) {
  throw '端口 8000 或 3000 已被其他进程占用。请先停止旧服务后重试。'
}
if (-not (Test-Path -LiteralPath $pythonExe)) { throw '未找到 Python 虚拟环境。请先在 services\python 运行 uv sync --python 3.13 --extra tts。' }
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules'))) { throw '未找到 Node.js 依赖。请先在仓库根目录运行 pnpm install。' }
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'apps\web\.env'))) { throw '未找到 apps\web\.env。请从 apps\web\.env.example 复制并配置。' }
$pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if (-not $pnpm) { throw '未找到 pnpm.cmd。请先安装并启用 pnpm。' }

$pathFFmpeg = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
$ffmpegCandidates = @($FFmpegBin, $env:M2V_FFMPEG_BIN, 'D:\Tools\ffmpeg-8.1.2-full-shared\bin', $(if ($pathFFmpeg) { Split-Path -Parent $pathFFmpeg.Source }))
$selectedFFmpeg = $null
foreach ($candidate in $ffmpegCandidates) {
  if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
  $ffmpegExe = Join-Path $candidate 'ffmpeg.exe'
  if (-not (Test-Path -LiteralPath $ffmpegExe) -or -not (Test-Path -LiteralPath (Join-Path $candidate 'ffprobe.exe'))) { continue }
  if (-not (Get-ChildItem -LiteralPath $candidate -Filter 'avcodec-*.dll' -File -ErrorAction SilentlyContinue | Select-Object -First 1)) { continue }
  $versionLine = (& $ffmpegExe -version | Select-Object -First 1)
  if ($versionLine -match '^ffmpeg version\s+(?:n)?8\.') { $selectedFFmpeg = (Resolve-Path -LiteralPath $candidate).Path; break }
}
if (-not $selectedFFmpeg) { throw '未找到 FFmpeg 8 full-shared。请用 -FFmpegBin 指定其 bin 目录。' }

$env:Path = "$selectedFFmpeg;$env:Path"
$env:M2V_DATA_DIR = Join-Path $repoRoot 'data'
New-Item -ItemType Directory -Path $stateDir, $logDir -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$pythonOut = Join-Path $logDir "python-$stamp.out.log"
$pythonErr = Join-Path $logDir "python-$stamp.err.log"
$webOut = Join-Path $logDir "web-worker-$stamp.out.log"
$webErr = Join-Path $logDir "web-worker-$stamp.err.log"
$python = $null
$web = $null

try {
  $python = Start-Process -FilePath $pythonExe -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000') -WorkingDirectory $pythonRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $pythonOut -RedirectStandardError $pythonErr
  Write-Host '正在启动 Python 服务…'
  Wait-Service 'http://127.0.0.1:8000/health' 8000 90 $python

  $web = Start-Process -FilePath $pnpm.Source -ArgumentList @('dev') -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $webOut -RedirectStandardError $webErr
  Write-Host '正在启动 Web 和渲染 Worker…'
  Wait-Service 'http://127.0.0.1:3000' 3000 120 $web

  $state = @{
    python = @{ id = $python.Id; startFileTime = $python.StartTime.ToFileTimeUtc() }
    web = @{ id = $web.Id; startFileTime = $web.StartTime.ToFileTimeUtc() }
    logs = @{ python = $pythonErr; web = $webErr }
  }
  $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statePath -Encoding utf8
  Write-Host '已启动：http://127.0.0.1:3000'
  Write-Host 'Python 健康检查：http://127.0.0.1:8000/health'
  Write-Host "日志目录：$logDir"
  Write-Host '停止命令：.\stop.ps1'
  if (-not (Test-Port 11434)) { Write-Warning 'Ollama 尚未运行；生成分镜前请启动 Ollama。' }
} catch {
  foreach ($started in @($web, $python)) {
    if ($null -ne $started -and -not $started.HasExited) { & taskkill.exe /PID $started.Id /T /F 2>$null | Out-Null }
  }
  Write-Warning "启动失败。请查看 $pythonErr 和 $webErr。"
  throw
}
