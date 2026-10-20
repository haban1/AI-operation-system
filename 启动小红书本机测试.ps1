$ErrorActionPreference='Stop'
$Root=Split-Path -Parent $MyInvocation.MyCommand.Path
$health=$null
try{$health=Invoke-RestMethod 'http://127.0.0.1:17831/health' -TimeoutSec 2}catch{}
if(-not $health){
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'start-mvp.ps1') -NoBrowser
  Start-Sleep -Seconds 3
}
$result=Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:17831/xiaohongshu/open-login' -ContentType 'application/json' -Body '{}'
Start-Process 'http://127.0.0.1:3100'
Write-Host ''
Write-Host '小红书本机测试环境已启动。' -ForegroundColor Green
Write-Host '1. 请在自动打开的 Chrome 中人工登录小红书。'
Write-Host '2. 登录完成后，在管理平台的“账号与设备”页面检查状态。'
Write-Host '3. 创建发布任务后，系统自动上传素材并填写内容。'
Write-Host '4. 最后由工作人员在小红书页面点击“发布”。'
Write-Host ''
Write-Host ('当前状态：'+$result.status.message)
