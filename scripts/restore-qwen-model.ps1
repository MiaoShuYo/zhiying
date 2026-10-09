$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$modelDirectory = Join-Path $repoRoot 'data\models\qwen3-4b'
$parts = Get-ChildItem -LiteralPath $modelDirectory -Filter 'qwen3-4b.gguf.part*' -File | Sort-Object Name
if ($parts.Count -lt 2) {
  throw "未找到完整的 Qwen GGUF 分片：$modelDirectory"
}

$outputPath = Join-Path $modelDirectory 'qwen3-4b.gguf'
$output = [System.IO.File]::Create($outputPath)
try {
  foreach ($part in $parts) {
    $input = [System.IO.File]::OpenRead($part.FullName)
    try {
      $input.CopyTo($output)
    }
    finally {
      $input.Dispose()
    }
  }
}
finally {
  $output.Dispose()
}

Write-Host "已还原模型文件：$outputPath"
