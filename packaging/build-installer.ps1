param(
  [string]$ReleaseTag = (Get-Date -Format 'yyyyMMdd-HHmm'),
  [string]$RagSource = '',
  [switch]$StageOnly,
  [switch]$CompileOnly
)
$ErrorActionPreference = 'Stop'
if ($ReleaseTag -notmatch '^[a-zA-Z0-9_-]+$') { throw 'ReleaseTag 只能使用英文字母、数字、下划线和短横线' }
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Stage = Join-Path $PSScriptRoot "staging\$ReleaseTag"
$Dist = Join-Path $ProjectRoot 'dist'
$BuildNode = Join-Path $ProjectRoot 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $BuildNode)) { $BuildNode = (Get-Command node.exe -ErrorAction Stop).Source }
$CurrentEnv = Join-Path $ProjectRoot '.env'
function Read-BuildEnv([string]$Name, [string]$Default = '') {
  $line = Get-Content -LiteralPath $CurrentEnv -Encoding UTF8 | Where-Object { $_.StartsWith("$Name=") } | Select-Object -Last 1
  if ($null -eq $line) { return $Default }
  return $line.Substring($Name.Length + 1).Trim()
}
function Copy-Tree([string]$Source, [string]$Destination, [string[]]$ExcludeDirectories = @(), [string[]]$ExcludeFiles = @()) {
  if (-not (Test-Path -LiteralPath $Source)) { throw "缺少打包目录：$Source" }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  $copyArguments = @($Source, $Destination, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1')
  if ($ExcludeDirectories.Count) { $copyArguments += '/XD'; $copyArguments += $ExcludeDirectories }
  if ($ExcludeFiles.Count) { $copyArguments += '/XF'; $copyArguments += $ExcludeFiles }
  & robocopy @copyArguments | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "复制 $Source 失败：robocopy=$LASTEXITCODE" }
}

if (-not $CompileOnly) {
  if (Test-Path -LiteralPath $Stage) { throw "暂存目录已存在，请换一个 ReleaseTag：$Stage" }
  if (-not $RagSource) { $RagSource = Read-BuildEnv 'RAG_PROJECT_ROOT' }
  if (-not $RagSource) { throw '请通过 -RagSource 指定当前 RAG 项目' }
  if (-not [IO.Path]::IsPathRooted($RagSource)) { $RagSource = Join-Path $ProjectRoot $RagSource }
  $RagSource = [IO.Path]::GetFullPath($RagSource)
  $RagPython = Join-Path $RagSource '.venv\Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $RagPython)) { throw '缺少当前 RAG Python 环境' }
  $PythonBase = (& $RagPython -c 'import sys; print(sys.base_prefix)').Trim()
  if ($LASTEXITCODE -ne 0) { throw '无法识别 Python 基础运行环境' }
  New-Item -ItemType Directory -Force -Path $Stage,$Dist,(Join-Path $Stage 'runtime'),(Join-Path $Stage 'data') | Out-Null
  foreach ($name in @('package.json','package-lock.json','.env.example','README.md','initialize-mvp.ps1','start-mvp.ps1','stop-mvp.ps1','start-mvp.cmd','stop-mvp.cmd','启动本地服务.cmd','停止本地服务.cmd')) {
    Copy-Item -LiteralPath (Join-Path $ProjectRoot $name) -Destination $Stage
  }
  & $BuildNode (Join-Path $PSScriptRoot 'prepare-runtime-config.mjs') $CurrentEnv (Join-Path $ProjectRoot '.env.example') (Join-Path $Stage '.env.example')
  if ($LASTEXITCODE -ne 0) { throw '安装采集通道配置准备失败' }
  foreach ($name in @('src','public','agent','platform-workflows')) {
    Copy-Tree (Join-Path $ProjectRoot $name) (Join-Path $Stage $name) @('__pycache__') @('*.bak*','*.before-*','*.pre-*','*.tmp','.env','*.pyc')
  }
  Copy-Tree (Join-Path $PSScriptRoot 'assets') (Join-Path $Stage 'assets')
  New-Item -ItemType Directory -Force -Path (Join-Path $Stage 'docs') | Out-Null
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '安装使用说明.md') -Destination (Join-Path $Stage 'docs\安装使用说明.md')

  Write-Host '正在生成知识库与配置快照，清除安装副本中的客户历史……'
  $TemplateDb = Join-Path $Stage 'data\mvp.db'
  & $BuildNode (Join-Path $ProjectRoot 'scripts\backup-current-db.mjs') (Join-Path $ProjectRoot 'data\mvp.db') $TemplateDb
  if ($LASTEXITCODE -ne 0) { throw '业务数据库快照失败' }
  & $BuildNode (Join-Path $PSScriptRoot 'prepare-template-db.mjs') $TemplateDb
  if ($LASTEXITCODE -ne 0) { throw '安装数据库清理失败' }
  $ActiveSettingsKey = Read-BuildEnv 'SETTINGS_ENCRYPTION_KEY'
  $KeyDestination = Join-Path $Stage 'data\.settings-key'
  if ($ActiveSettingsKey) {
    if ($ActiveSettingsKey -match '^[0-9a-fA-F]{64}$') { $hexKey = $ActiveSettingsKey.ToLowerInvariant() }
    else {
      $decoded = $null
      try { $decoded = [Convert]::FromBase64String($ActiveSettingsKey) } catch {}
      if ($decoded -and $decoded.Length -eq 32) { $digest = $decoded }
      else { $sha = [Security.Cryptography.SHA256]::Create(); try { $digest = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($ActiveSettingsKey)) } finally { $sha.Dispose() } }
      $hexKey = ($digest | ForEach-Object { $_.ToString('x2') }) -join ''
    }
    [IO.File]::WriteAllText($KeyDestination, $hexKey, [Text.UTF8Encoding]::new($false))
  } else { Copy-Item -LiteralPath (Join-Path $ProjectRoot 'data\.settings-key') -Destination $KeyDestination }

  Write-Host '正在准备可独立运行的 Node、媒体依赖和浏览器……'
  Copy-Item -LiteralPath $BuildNode -Destination (Join-Path $Stage 'runtime\node.exe')
  $SystemNode = (Get-Command node.exe -ErrorAction Stop).Source
  $NpmCli = Join-Path (Split-Path -Parent $SystemNode) 'node_modules\npm\bin\npm-cli.js'
  if (-not (Test-Path -LiteralPath $NpmCli)) { throw '构建电脑需要 npm；目标电脑不需要安装 npm' }
  & $BuildNode $NpmCli ci --omit=dev --no-audit --no-fund --prefix $Stage
  if ($LASTEXITCODE -ne 0) { throw '安装锁定版本的生产依赖失败' }
  $ChromeRoot = 'C:\Program Files\Google\Chrome\Application'
  if (-not (Test-Path -LiteralPath (Join-Path $ChromeRoot 'chrome.exe'))) { throw '构建电脑未找到 Chrome' }
  Copy-Tree $ChromeRoot (Join-Path $Stage 'runtime\browser') @('Installer','SetupMetrics') @('debug.log')

  Write-Host '正在准备可搬迁的 Python 和 RAG……'
  $PythonDestination = Join-Path $Stage 'runtime\python'
  New-Item -ItemType Directory -Force -Path $PythonDestination | Out-Null
  Get-ChildItem -LiteralPath $PythonBase -File | Where-Object { $_.Extension -in @('.exe','.dll') -or $_.Name -eq 'LICENSE.txt' } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $PythonDestination }
  foreach ($name in @('msvcp140.dll','msvcp140_1.dll','msvcp140_2.dll','msvcp140_atomic_wait.dll','msvcp140_codecvt_ids.dll','concrt140.dll')) {
    $Redistributable = Join-Path $env:WINDIR "System32\$name"
    if (Test-Path -LiteralPath $Redistributable) { Copy-Item -LiteralPath $Redistributable -Destination $PythonDestination }
  }
  Copy-Tree (Join-Path $PythonBase 'DLLs') (Join-Path $PythonDestination 'DLLs') @('__pycache__') @('*.pyc')
  Copy-Tree (Join-Path $PythonBase 'Lib') (Join-Path $PythonDestination 'Lib') @('site-packages','__pycache__','test','tests','idlelib','tkinter','ensurepip') @('*.pyc')
  Copy-Tree (Join-Path $RagSource '.venv\Lib\site-packages') (Join-Path $PythonDestination 'Lib\site-packages') @('__pycache__','tests','_pytest','pytest','pytest_asyncio','respx') @('*.pyc','_virtualenv.pth','_virtualenv.py')
  $RagDestination = Join-Path $Stage 'rag'
  foreach ($name in @('app','static')) { Copy-Tree (Join-Path $RagSource $name) (Join-Path $RagDestination $name) @('__pycache__') @('*.pyc') }
  foreach ($name in @('pyproject.toml','uv.lock','.env.example','README.md')) { Copy-Item -LiteralPath (Join-Path $RagSource $name) -Destination $RagDestination }
  & $BuildNode (Join-Path $PSScriptRoot 'prepare-rag-bundle.mjs') $RagSource $RagDestination
  if ($LASTEXITCODE -ne 0) { throw 'RAG 知识与本地模型打包失败' }
  & (Join-Path $PythonDestination 'python.exe') -I (Join-Path $PSScriptRoot 'rebuild-rag-index.py') $RagDestination
  if ($LASTEXITCODE -ne 0) { throw 'RAG 向量索引重建失败' }
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '安装使用说明.md') -Destination (Join-Path $Stage '安装使用说明.txt')
  Push-Location $Stage
  try {
    & (Join-Path $Stage 'runtime\node.exe') -e "Promise.all([import('sharp'),import('@ffmpeg-installer/ffmpeg'),import('ffprobe-static'),import('playwright-core'),import('mammoth')]).then(()=>console.log('Node production dependencies OK')).catch(e=>{console.error(e);process.exit(1)})"
    if ($LASTEXITCODE -ne 0) { throw 'Node 运行依赖检查失败' }
    & (Join-Path $PythonDestination 'python.exe') -I -c "import fastapi, uvicorn, numpy, onnxruntime, fastembed, pymupdf, openpyxl, docx, qdrant_client, deepagents; print('Python production dependencies OK')"
    if ($LASTEXITCODE -ne 0) { throw 'Python 运行依赖检查失败' }
  } finally { Pop-Location }
}

if ($StageOnly) { Write-Host "STAGING_READY=$Stage"; exit 0 }
if (-not (Test-Path -LiteralPath (Join-Path $Stage 'rag\data\rag.db'))) { throw '缺少完整 RAG 安装副本' }
$Nsis = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'tools\nsis') -Recurse -Filter makensis.exe -File | Select-Object -First 1 -ExpandProperty FullName
if (-not $Nsis) { throw '未找到 NSIS 编译器' }
& $Nsis '/V2' "/DRELEASE_TAG=$ReleaseTag" "/DSTAGE=$Stage" (Join-Path $PSScriptRoot 'installer.nsi')
if ($LASTEXITCODE -ne 0) { throw 'NSIS 构建失败' }
$Installer = Join-Path $Dist "Tianhe-AI-Digital-Employee-OneClick-Setup-$ReleaseTag.exe"
$Hash = Get-FileHash -Algorithm SHA256 -LiteralPath $Installer
"$($Hash.Hash)  $([IO.Path]::GetFileName($Installer))" | Set-Content -LiteralPath (Join-Path $Dist "$ReleaseTag.sha256.txt") -Encoding ASCII
Get-Item -LiteralPath $Installer | Select-Object FullName,Length,LastWriteTime | ConvertTo-Json
