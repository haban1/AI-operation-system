Unicode true
# Per-file compression avoids the solid data block's 2 GiB uncompressed limit.
SetCompressor zlib
RequestExecutionLevel user
AutoCloseWindow true
ShowInstDetails show
ShowUninstDetails show

!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!ifndef RELEASE_TAG
  !define RELEASE_TAG "20260820"
!endif
!define PRODUCT_NAME "天河AI数字员工平台"
!define PRODUCT_VERSION "0.1.0"
!define INSTALL_DIR "$LOCALAPPDATA\TianheAIDigitalEmployee"
!ifndef STAGE
  !define STAGE "staging"
!endif

Name "${PRODUCT_NAME} ${PRODUCT_VERSION}"
OutFile "..\dist\Tianhe-AI-Digital-Employee-OneClick-Setup-${RELEASE_TAG}.exe"
InstallDir "${INSTALL_DIR}"
BrandingText "天河 AI 数字员工平台"
Icon "assets\app.ico"
UninstallIcon "assets\app.ico"

Var NoStart
Var UninstallMode
Var NoShortcuts

Page instfiles
UninstPage instfiles

Function .onInit
  StrCpy $NoStart "0"
  StrCpy $NoShortcuts "0"
  ${GetOptions} $CMDLINE "/NOSTART" $0
  ${IfNot} ${Errors}
    StrCpy $NoStart "1"
  ${EndIf}
  ${GetOptions} $CMDLINE "/NOSHORTCUTS" $0
  ${IfNot} ${Errors}
    StrCpy $NoShortcuts "1"
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "此安装包需要 64 位 Windows。"
    Abort
  ${EndIf}
FunctionEnd

Section "一键安装完整平台" SecMain
  SetShellVarContext current

  # Always run this package's preflight, including upgrades from older packages
  # whose installed stop script relies on missing or stale PID files.
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=stop-installed-runtime.ps1 "stop-installed-runtime.ps1"
  CheckInstalledRuntime:
    nsExec::ExecToLog /TIMEOUT=90000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-installed-runtime.ps1" -InstallRoot "$INSTDIR" -LogPath "$TEMP\TianheAI-installer-${RELEASE_TAG}.log"'
    Pop $0
    StrCmp $0 "0" InstallFiles
    SetErrorLevel 2
    IfSilent PreinstallFailed
    MessageBox MB_RETRYCANCEL|MB_ICONSTOP "安装前检查未通过，暂未覆盖程序文件。旧服务可能仍占用文件，或安装目录不可写。$\r$\n$\r$\n请先关闭旧平台；必要时重启电脑后直接安装。$\r$\n安装目录：$INSTDIR$\r$\n诊断日志：$TEMP\TianheAI-installer-${RELEASE_TAG}.log$\r$\n$\r$\n处理后点“重试”，或点“取消”退出。" IDRETRY CheckInstalledRuntime
    PreinstallFailed:
      Abort
  InstallFiles:
  SetErrorLevel 0

  SetOutPath "$INSTDIR"
  SetOverwrite off
  SetOutPath "$INSTDIR\data"
  File "${STAGE}\data\mvp.db"
  File "${STAGE}\data\.settings-key"
  SetOutPath "$INSTDIR\rag"
  # RAG data, indexes and configuration form one snapshot; never mix a newer
  # package's index files into an existing installation's knowledge database.
  IfFileExists "$INSTDIR\rag\data\rag.db" RagDataPresent
    File /r "${STAGE}\rag\data"
  RagDataPresent:

  SetOutPath "$INSTDIR"
  SetOverwrite on
  File "${STAGE}\.env.example"
  File "${STAGE}\package.json"
  File "${STAGE}\package-lock.json"
  File "${STAGE}\README.md"
  File "${STAGE}\安装使用说明.txt"
  File "${STAGE}\initialize-mvp.ps1"
  File "${STAGE}\start-mvp.ps1"
  File "${STAGE}\stop-mvp.ps1"
  File "${STAGE}\start-mvp.cmd"
  File "${STAGE}\stop-mvp.cmd"
  File "${STAGE}\启动本地服务.cmd"
  File "${STAGE}\停止本地服务.cmd"
  File /r "${STAGE}\agent"
  File /r "${STAGE}\src"
  File /r "${STAGE}\public"
  File /r "${STAGE}\platform-workflows"
  File /r "${STAGE}\docs"
  File /r "${STAGE}\node_modules"
  File /r "${STAGE}\runtime"
  File /r "${STAGE}\assets"
  SetOutPath "$INSTDIR\rag"
  File "${STAGE}\rag\.env.example"
  File "${STAGE}\rag\pyproject.toml"
  File "${STAGE}\rag\uv.lock"
  File "${STAGE}\rag\README.md"
  File /r "${STAGE}\rag\app"
  File /r "${STAGE}\rag\static"
  File /r "${STAGE}\rag\models"
  SetOutPath "$INSTDIR"

    # Initialize a fresh installation or add missing bundled RAG configuration.
    # Existing collection preferences and credentials remain unchanged.
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\initialize-mvp.ps1" -Quiet'
    Pop $0
    StrCmp $0 "0" ConfigDone
      MessageBox MB_ICONSTOP "运行配置生成失败（代码 $0）。请运行安装目录中的 initialize-mvp.ps1。"
      Abort
  ConfigDone:

  WriteUninstaller "$INSTDIR\卸载天河AI数字员工平台.exe"
  StrCmp $NoShortcuts "1" ShortcutsDone
  CreateDirectory "$SMPROGRAMS\天河AI数字员工平台"
  CreateShortCut "$DESKTOP\天河AI数字员工平台.lnk" "$INSTDIR\start-mvp.cmd" "" "$INSTDIR\assets\app.ico" 0
  CreateShortCut "$DESKTOP\停止天河AI数字员工平台.lnk" "$INSTDIR\stop-mvp.cmd" "" "$INSTDIR\assets\app.ico" 0
  CreateShortCut "$DESKTOP\一键卸载天河AI数字员工平台（保留数据）.lnk" "$INSTDIR\卸载天河AI数字员工平台.exe" "/KEEPDATA" "$INSTDIR\assets\app.ico" 0
  CreateShortCut "$DESKTOP\一键彻底删除天河AI数字员工平台.lnk" "$INSTDIR\卸载天河AI数字员工平台.exe" "/PURGE" "$INSTDIR\assets\app.ico" 0
  CreateShortCut "$SMPROGRAMS\天河AI数字员工平台\启动平台.lnk" "$INSTDIR\start-mvp.cmd" "" "$INSTDIR\assets\app.ico" 0
  CreateShortCut "$SMPROGRAMS\天河AI数字员工平台\停止平台.lnk" "$INSTDIR\stop-mvp.cmd" "" "$INSTDIR\assets\app.ico" 0
  CreateShortCut "$SMPROGRAMS\天河AI数字员工平台\首次登录信息.lnk" "$INSTDIR\首次登录信息.txt"
  CreateShortCut "$SMPROGRAMS\天河AI数字员工平台\安装使用说明.lnk" "$INSTDIR\安装使用说明.txt"
  CreateShortCut "$SMPROGRAMS\天河AI数字员工平台\一键卸载（保留数据库和配置）.lnk" "$INSTDIR\卸载天河AI数字员工平台.exe" "/KEEPDATA" "$INSTDIR\assets\app.ico" 0
  CreateShortCut "$SMPROGRAMS\天河AI数字员工平台\一键彻底删除全部数据.lnk" "$INSTDIR\卸载天河AI数字员工平台.exe" "/PURGE" "$INSTDIR\assets\app.ico" 0

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TianheAIDigitalEmployee" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TianheAIDigitalEmployee" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TianheAIDigitalEmployee" "Publisher" "天河港澳社区"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TianheAIDigitalEmployee" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TianheAIDigitalEmployee" "DisplayIcon" "$INSTDIR\assets\app.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TianheAIDigitalEmployee" "UninstallString" '$\"$INSTDIR\卸载天河AI数字员工平台.exe$\" /KEEPDATA'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TianheAIDigitalEmployee" "QuietUninstallString" '$\"$INSTDIR\卸载天河AI数字员工平台.exe$\" /S /KEEPDATA'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TianheAIDigitalEmployee" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TianheAIDigitalEmployee" "NoRepair" 1
  ShortcutsDone:

  StrCmp $NoStart "1" Done
    Exec 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "$INSTDIR\start-mvp.ps1"'
  Done:
SectionEnd

Function un.onInit
  StrCpy $UninstallMode "KEEP"
  ${GetOptions} $CMDLINE "/PURGE" $0
  ${IfNot} ${Errors}
    StrCpy $UninstallMode "PURGE"
  ${EndIf}
  ${GetOptions} $CMDLINE "/KEEPDATA" $0
  ${IfNot} ${Errors}
    StrCpy $UninstallMode "KEEP"
  ${EndIf}

  StrCmp $UninstallMode "PURGE" 0 InitDone
  IfSilent InitDone
  MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "一键彻底删除会永久删除程序、数据库、知识库数据、历史记录、AI 配置、日志和平台本地登录资料。该操作不可恢复，确定继续吗？" IDYES InitDone
    Abort
  InitDone:
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\stop-mvp.ps1"'
  Pop $0

  Delete "$DESKTOP\天河AI数字员工平台.lnk"
  Delete "$DESKTOP\停止天河AI数字员工平台.lnk"
  Delete "$DESKTOP\一键卸载天河AI数字员工平台（保留数据）.lnk"
  Delete "$DESKTOP\一键彻底删除天河AI数字员工平台.lnk"
  RMDir /r "$SMPROGRAMS\天河AI数字员工平台"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TianheAIDigitalEmployee"

  StrCmp $UninstallMode "PURGE" PurgeAll

  # 保留 .env、data、logs、outputs、tmp，只移除程序及运行时。
  RMDir /r "$INSTDIR\agent"
  RMDir /r "$INSTDIR\src"
  RMDir /r "$INSTDIR\public"
  RMDir /r "$INSTDIR\scripts"
  RMDir /r "$INSTDIR\sample-material"
  RMDir /r "$INSTDIR\platform-workflows"
  RMDir /r "$INSTDIR\docs"
  RMDir /r "$INSTDIR\node_modules"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\assets"
  RMDir /r "$INSTDIR\rag\app"
  RMDir /r "$INSTDIR\rag\static"
  RMDir /r "$INSTDIR\rag\models"
  Delete "$INSTDIR\rag\.env.example"
  Delete "$INSTDIR\rag\pyproject.toml"
  Delete "$INSTDIR\rag\uv.lock"
  Delete "$INSTDIR\rag\README.md"
  Delete "$INSTDIR\package.json"
  Delete "$INSTDIR\package-lock.json"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\.env.example"
  Delete "$INSTDIR\initialize-mvp.ps1"
  Delete "$INSTDIR\start-mvp.ps1"
  Delete "$INSTDIR\stop-mvp.ps1"
  Delete "$INSTDIR\start-mvp.cmd"
  Delete "$INSTDIR\stop-mvp.cmd"
  Delete "$INSTDIR\启动本地服务.cmd"
  Delete "$INSTDIR\停止本地服务.cmd"
  Delete "$INSTDIR\安装使用说明.txt"
  Delete "$INSTDIR\首次登录信息.txt"
  Delete /REBOOTOK "$INSTDIR\卸载天河AI数字员工平台.exe"
  IfSilent UninstallDone
    MessageBox MB_OK|MB_ICONINFORMATION "程序已卸载；数据库、配置和日志仍保留在 $INSTDIR，以后重新安装即可继续使用。"
  Goto UninstallDone

  PurgeAll:
    RMDir /r /REBOOTOK "$INSTDIR"

  UninstallDone:
SectionEnd
