param(
  [Parameter(Mandatory=$true)][string]$InstallRoot,
  [ValidateRange(1,60)][int]$WaitSeconds = 20,
  [string]$LogPath = ''
)
$ErrorActionPreference = 'Stop'

function Write-PreinstallLog([string]$Message) {
  Write-Output $Message
  if ($LogPath) {
    [IO.File]::AppendAllText($LogPath, "$Message`r`n", [Text.UTF8Encoding]::new($false))
  }
}

try {
  if (-not [IO.Path]::IsPathRooted($InstallRoot)) { throw 'InstallRoot must be an absolute path.' }
  $TargetRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\', '/')
  $DriveRoot = [IO.Path]::GetPathRoot($TargetRoot).TrimEnd('\', '/')
  $DisallowedRoots = @($DriveRoot, $env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA, $env:WINDIR, $env:ProgramFiles, ${env:ProgramFiles(x86)})
  if (-not $TargetRoot -or $TargetRoot -in $DisallowedRoots) { throw 'Refusing a broad system or user directory.' }
  Write-PreinstallLog "INSTALL_ROOT=$TargetRoot"
  if (-not (Test-Path -LiteralPath $TargetRoot)) {
    Write-PreinstallLog 'PREFLIGHT_OK: fresh installation; no previous runtime.'
    exit 0
  }
  $NodePath = Join-Path $TargetRoot 'runtime\node.exe'
  $IsEmpty = @(Get-ChildItem -LiteralPath $TargetRoot -Force | Select-Object -First 1).Count -eq 0
  $HasPreservedData = (Test-Path -LiteralPath (Join-Path $TargetRoot '.env')) -and (Test-Path -LiteralPath (Join-Path $TargetRoot 'data\mvp.db'))
  if (-not $IsEmpty -and -not $HasPreservedData -and -not (Test-Path -LiteralPath $NodePath) -and -not (Test-Path -LiteralPath (Join-Path $TargetRoot 'initialize-mvp.ps1'))) {
    throw 'The existing target is not a recognized platform installation.'
  }
  $RuntimeRoot = Join-Path $TargetRoot 'runtime'
  $RuntimePrefix = "$RuntimeRoot\"
  $MediaPaths = @(
    (Join-Path $TargetRoot 'node_modules\@ffmpeg-installer\win32-x64\ffmpeg.exe'),
    (Join-Path $TargetRoot 'node_modules\ffprobe-static\bin\win32\x64\ffprobe.exe')
  )
  function Test-OwnedExecutable([string]$ExecutablePath) {
    return $ExecutablePath -and ($ExecutablePath.StartsWith($RuntimePrefix, [StringComparison]::OrdinalIgnoreCase) -or $ExecutablePath -in $MediaPaths)
  }
  function Get-OwnedProcesses {
    Get-CimInstance Win32_Process | Where-Object { Test-OwnedExecutable $_.ExecutablePath }
  }

  # PID files can be missing or stale. Use the executable's absolute path and
  # revalidate the process before stopping it, never every process named node.
  # Stop the Web watchdog first so it cannot restart Local Agent during upgrade.
  $Deadline = (Get-Date).AddSeconds($WaitSeconds)
  do {
    $OwnedProcesses = @(Get-OwnedProcesses | Sort-Object @{Expression={
      if ($_.ExecutablePath -ieq $NodePath -and $_.CommandLine -match 'src[\\/]server\.js') { 0 }
      elseif ($_.ExecutablePath -ieq $NodePath) { 1 }
      else { 2 }
    }})
    foreach ($OwnedProcess in $OwnedProcesses) {
      $Current = Get-CimInstance Win32_Process -Filter "ProcessId=$($OwnedProcess.ProcessId)"
      if ($Current -and $Current.CreationDate -eq $OwnedProcess.CreationDate -and (Test-OwnedExecutable $Current.ExecutablePath)) {
        try {
          Stop-Process -Id $Current.ProcessId -Force -ErrorAction Stop
          Write-PreinstallLog "STOPPED: PID=$($Current.ProcessId) FILE=$($Current.ExecutablePath)"
        } catch {
          if (Get-CimInstance Win32_Process -Filter "ProcessId=$($OwnedProcess.ProcessId)") { throw }
        }
      }
    }
    if ($OwnedProcesses.Count) { Start-Sleep -Milliseconds 250 }
    $Remaining = @(Get-OwnedProcesses)
  } while ($Remaining.Count -and (Get-Date) -lt $Deadline)
  if ($Remaining.Count) { throw 'RUNTIME_STILL_RUNNING: could not stop all processes belonging to this installation.' }

  # Opening for writing without writing any bytes catches both loaded binaries
  # and permission/read-only failures before the installer overwrites any files.
  $RuntimeFiles = @()
  if (Test-Path -LiteralPath $RuntimeRoot) {
    $RuntimeFiles += Get-ChildItem -LiteralPath $RuntimeRoot -Recurse -File | Where-Object { $_.Extension -in @('.exe','.dll','.pyd','.node') }
  }
  foreach ($MediaPath in $MediaPaths) {
    if (Test-Path -LiteralPath $MediaPath) { $RuntimeFiles += Get-Item -LiteralPath $MediaPath }
  }
  foreach ($RuntimeFile in $RuntimeFiles) {
    $Handle = $null
    try {
      $Handle = [IO.File]::Open($RuntimeFile.FullName, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
    } catch {
      throw "NOT_WRITABLE: $($RuntimeFile.FullName) -- $($_.Exception.Message)"
    } finally {
      if ($Handle) { $Handle.Dispose() }
    }
  }
  Write-PreinstallLog "PREFLIGHT_OK: runtime stopped; $($RuntimeFiles.Count) files checked. Existing data and configuration preserved."
  exit 0
} catch {
  Write-PreinstallLog "PREFLIGHT_FAILED: $($_.Exception.Message)"
  exit 1
}
