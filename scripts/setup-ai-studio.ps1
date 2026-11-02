param([string]$BuildProxy = '', [switch]$PrepareOnly, [switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$studioProjectDir = Split-Path $PSScriptRoot -Parent
Set-Location $studioProjectDir
if (-not (Test-Path -LiteralPath '.env.docker')) { throw 'Prepare the Tianhe .env.docker configuration first.' }
$studioEnvText = [IO.File]::ReadAllText((Join-Path $studioProjectDir '.env.docker'))
function Read-StudioEnv([string]$Text, [string]$Name) {
  $studioMatch = [regex]::Matches($Text, "(?m)^$Name=(.*)$")
  if (-not $studioMatch.Count) { return '' }
  return $studioMatch[$studioMatch.Count - 1].Groups[1].Value.Trim().Trim('"').Trim("'")
}
$studioModelToken = Read-StudioEnv $studioEnvText 'TIANHE_MODEL_TOKEN'
if ($studioModelToken -notmatch '^[A-Za-z0-9._-]+$') { throw 'A valid TIANHE_MODEL_TOKEN is required.' }
$studioToken = Read-StudioEnv $studioEnvText 'AI_STUDIO_TOKEN'
$studioEncoding = [Text.UTF8Encoding]::new($false)
if (-not $studioToken) {
  $studioToken = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
  $studioBackupDir = Join-Path $studioProjectDir 'backups/ai-studio-local-20261026'
  New-Item -ItemType Directory -Force -Path $studioBackupDir | Out-Null
  if (-not (Test-Path -LiteralPath "$studioBackupDir/.env.docker.before")) { Copy-Item -LiteralPath '.env.docker' -Destination "$studioBackupDir/.env.docker.before" }
  [IO.File]::WriteAllText((Join-Path $studioProjectDir '.env.docker'), $studioEnvText.TrimEnd()+"`nAI_STUDIO_TOKEN=$studioToken`n", $studioEncoding)
}
if ($studioToken -notmatch '^[A-Za-z0-9._-]{32,}$') { throw 'AI_STUDIO_TOKEN has an invalid format.' }
[IO.File]::WriteAllText((Join-Path $studioProjectDir '.env.ai-studio'), "TIANHE_MODEL_TOKEN=$studioModelToken`nAI_STUDIO_TOKEN=$studioToken`n", $studioEncoding)
foreach ($studioFolder in @('projects','runs','data/comparisons')) { New-Item -ItemType Directory -Force -Path "runtime/workbench/ai-studio/$studioFolder" | Out-Null }
if (-not (Test-Path -LiteralPath 'runtime/workbench/ai-studio/data/library-review.json')) { [IO.File]::WriteAllText((Join-Path $studioProjectDir 'runtime/workbench/ai-studio/data/library-review.json'), '{"runs":{}}', $studioEncoding) }
Write-Host 'AI Studio local data and internal model connection prepared.'
if ($PrepareOnly) { return }
$studioComposeArgs = @('compose', '-f', 'compose.yaml', '-f', 'compose.wechat.yaml', '-f', 'compose.workbench.yaml')
if (-not $SkipBuild) {
  $studioBuildArgs = @('build')
  if ($BuildProxy) { $studioBuildArgs += @('--build-arg', "HTTP_PROXY=$BuildProxy", '--build-arg', "HTTPS_PROXY=$BuildProxy", '--build-arg', 'NO_PROXY=localhost,127.0.0.1') }
  & docker @studioComposeArgs @studioBuildArgs ai-studio
  if ($LASTEXITCODE -ne 0) { throw 'AI Studio build failed.' }
}
& docker @studioComposeArgs up -d --no-deps --wait --wait-timeout 120 ai-studio
if ($LASTEXITCODE -ne 0) { throw 'AI Studio startup failed.' }
& docker @studioComposeArgs up -d --force-recreate --no-deps --wait --wait-timeout 90 web
if ($LASTEXITCODE -ne 0) { throw 'Tianhe workbench connection failed.' }
Write-Host 'AI Studio: http://127.0.0.1:3100/ai-studio/index.html'
Write-Host 'Workbench: http://127.0.0.1:3100/#studio'
