param(
  [Parameter(Mandatory = $true)][string]$InputJson,
  [Parameter(Mandatory = $true)][string]$OutputWav,
  [Parameter(Mandatory = $true)][string]$OutputJson
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$request = Get-Content -LiteralPath $InputJson -Raw -Encoding UTF8 | ConvertFrom-Json
$narration = [string]$request.narration
if ([string]::IsNullOrWhiteSpace($narration)) { throw 'Narration must not be empty.' }

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voice = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo } | Where-Object { $_.Name -eq 'Microsoft Huihui Desktop' } | Select-Object -First 1
  if (-not $voice) { throw 'Microsoft Huihui Desktop is unavailable.' }
  $synth.SelectVoice($voice.Name)
  $synth.Rate = 0
  $progress = [System.Collections.Generic.List[object]]::new()
  $synth.add_SpeakProgress({
    param($sender, $eventArgs)
    $progress.Add([pscustomobject]@{
      characterPosition = [int]$eventArgs.CharacterPosition
      characterCount = [int]$eventArgs.CharacterCount
      startSeconds = [Math]::Round($eventArgs.AudioPosition.TotalSeconds, 6)
    })
  })
  $synth.SetOutputToWaveFile($OutputWav)
  $synth.Speak($narration)
  $synth.SetOutputToNull()

  $events = @($progress | Sort-Object startSeconds, characterPosition)
  if (-not $events.Count) { throw 'SAPI returned no SpeakProgress timing events.' }
  $payload = [pscustomobject]@{
    voice = $voice.Name
    engine = 'Windows System.Speech / SAPI'
    rate = 0
    timingKind = 'SpeakProgress character spans'
    narration = $narration
    events = $events
  }
  $payload | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $OutputJson -Encoding UTF8
}
finally {
  $synth.Dispose()
}
