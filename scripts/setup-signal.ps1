param([string]$BuildProxy = '', [switch]$PrepareOnly, [switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$signalProjectDir = Split-Path $PSScriptRoot -Parent
Set-Location $signalProjectDir
$signalEnv = [IO.File]::ReadAllText((Join-Path $signalProjectDir '.env.docker'))
$signalTokenMatch = [regex]::Matches($signalEnv, '(?m)^TIANHE_MODEL_TOKEN=(.*)$')
if (-not $signalTokenMatch.Count) { throw 'TIANHE_MODEL_TOKEN is missing.' }
$signalToken = $signalTokenMatch[$signalTokenMatch.Count - 1].Groups[1].Value.Trim().Trim('"').Trim("'")
if ($signalToken -notmatch '^[A-Za-z0-9._-]+$') { throw 'Invalid internal model token.' }
$signalUtf8 = [Text.UTF8Encoding]::new($false)
$signalEnvFile = Join-Path $signalProjectDir '.env.signal'
$signalExisting = if (Test-Path -LiteralPath $signalEnvFile) { [IO.File]::ReadAllText($signalEnvFile) } else { '' }
if ($signalExisting) {
  $signalBackup = Join-Path $signalProjectDir ('backups/signal-env-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item -ItemType Directory -Force -Path $signalBackup | Out-Null
  Copy-Item -LiteralPath $signalEnvFile -Destination "$signalBackup/.env.signal"
}
$signalExisting = [regex]::Replace($signalExisting, '(?m)^VIDEO_LLM_API_KEY=.*\r?\n?', '')
[IO.File]::WriteAllText($signalEnvFile, $signalExisting.TrimEnd()+"`nVIDEO_LLM_API_KEY=$signalToken`n", $signalUtf8)
foreach ($signalFolder in @('runs','data','config')) { New-Item -ItemType Directory -Force -Path "runtime/workbench/signal/$signalFolder" | Out-Null }
$signalConfigFile = Join-Path $signalProjectDir 'runtime/workbench/signal/config/config.json'
$signalSettings = if (Test-Path -LiteralPath $signalConfigFile) { Get-Content -LiteralPath $signalConfigFile -Raw | ConvertFrom-Json } else { Get-Content engines/ai-signal-studio/config.example.json -Raw | ConvertFrom-Json }
$signalSettings.llm = [pscustomobject]@{ provider='compatible'; base_url='http://web:3100/api/model/v1'; model='tianhe-workbench-chat' }
[IO.File]::WriteAllText($signalConfigFile, ($signalSettings | ConvertTo-Json -Depth 12), $signalUtf8)
Write-Host 'Signal configured to use the Tianhe model gateway. No provider key copied.'
if ($PrepareOnly) { return }
$signalCompose = @('compose','-f','compose.yaml','-f','compose.wechat.yaml','-f','compose.workbench.yaml')
if (-not $SkipBuild) {
  $signalBuild = @('build')
  if ($BuildProxy) { $signalBuild += @('--build-arg', "HTTP_PROXY=$BuildProxy", '--build-arg', "HTTPS_PROXY=$BuildProxy", '--build-arg', 'NO_PROXY=localhost,127.0.0.1') }
  & docker @signalCompose @signalBuild signal
  if ($LASTEXITCODE -ne 0) { throw 'Signal build failed.' }
}
& docker @signalCompose up -d --no-deps --wait --wait-timeout 180 signal
if ($LASTEXITCODE -ne 0) { throw 'Signal startup failed.' }
& docker @signalCompose up -d --force-recreate --no-deps --wait --wait-timeout 90 web
if ($LASTEXITCODE -ne 0) { throw 'Tianhe startup failed.' }
Write-Host 'AI Signal Studio: http://127.0.0.1:3100/integrations/ai-signal/'
