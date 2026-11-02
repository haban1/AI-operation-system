param([switch]$InstallAutostart)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' }
if (-not (Test-Path -LiteralPath $nodePath)) { throw 'Node.js 24 or newer is required.' }
$runnerPath = Join-Path $PSScriptRoot 'windows-browser-agent.mjs'
$runtimePath = Join-Path $projectRoot 'runtime/browser-agent'
New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
if ($InstallAutostart) {
    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $scriptPath = Join-Path $PSScriptRoot 'start-windows-browser-agent.ps1'
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $scriptPath + '"') -WorkingDirectory $projectRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
    try {
        Register-ScheduledTask -TaskName 'Tianhe-Windows-Browser-Agent' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
        Write-Host 'Autostart registered for the current interactive Windows user.'
    } catch {
        $startupDir = [Environment]::GetFolderPath('Startup')
        $command = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $scriptPath + '"'
        $vbs = 'CreateObject("WScript.Shell").Run "' + $command.Replace('"','""') + '", 0, False'
        Set-Content -LiteralPath (Join-Path $startupDir 'Tianhe-Windows-Browser-Agent.vbs') -Value $vbs -Encoding ASCII
        Write-Host 'Autostart installed in the current user Startup folder.'
    }
}
$pidPath = Join-Path $runtimePath 'supervisor.pid'
if (Test-Path -LiteralPath $pidPath) {
    $supervisorProcessId = [int](Get-Content -LiteralPath $pidPath -Raw)
    $existingProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $supervisorProcessId" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*windows-browser-agent.mjs*' }
    if ($existingProcess) { Write-Host 'Windows browser agent is already running.'; exit 0 }
}
Start-Process -FilePath $nodePath -ArgumentList ('"' + $runnerPath + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'supervisor.out.log') -RedirectStandardError (Join-Path $runtimePath 'supervisor.err.log')
Write-Host 'Windows browser agent started. Logs: runtime/browser-agent'
