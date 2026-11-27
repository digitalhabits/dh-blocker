; Resolve companion scripts while this file is !include'd by Tauri's
; installer.nsi. Inside !macro bodies, ${__FILEDIR__} expands to the
; generated nsis/<arch>/ directory (where installer.nsi lives), not
; windows/ — so File would miss legacy-preinstall.ps1 at makensis time.
!define LEGACY_PREINSTALL_PS1 "${__FILEDIR__}\legacy-preinstall.ps1"
!define SILENT_MSI_RECOVERY_MESSAGE "An older MSI installation was found. Run this installer interactively so setup can verify Windows hosts and save recovery copies."

; Tauri's maintenance page may run an older same-product NSIS or WiX
; uninstaller before NSIS_HOOK_PREINSTALL. MUI calls this before all
; installer pages, including passive-mode callbacks. Silent setup
; skips both GUI init and the maintenance page.
Var HostsSnapshotFile
!define MUI_CUSTOMFUNCTION_GUIINIT SnapshotHostsBeforeMaintenance
Function SnapshotHostsBeforeMaintenance
  Call FindWixInstall
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Digital Habits Blocker" "UninstallString"
  ReadRegStr $1 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Digital Habits Blocker" "UninstallString"
  ${If} $0 == ""
  ${AndIf} $1 == ""
  ${AndIf} $R6 == ""
    Return
  ${EndIf}
  ; Pinned Tauri bypasses NSIS maintenance uninstall for /UPDATE,
  ; but its WiX migration branch takes precedence over /UPDATE.
  ${If} $R6 == ""
    ClearErrors
    ${GetOptions} $CMDLINE "/UPDATE" $2
    ${IfNot} ${Errors}
      Return
    ${EndIf}
  ${EndIf}

  InitPluginsDir
  File "/oname=$PLUGINSDIR\legacy-preinstall.ps1" "${LEGACY_PREINSTALL_PS1}"
  StrCpy $HostsSnapshotFile "$PLUGINSDIR\hosts-recovery.json"
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\legacy-preinstall.ps1" -BeforeMaintenance -SnapshotFile "$HostsSnapshotFile" -ProtectOlderUninstaller'
  Pop $0
  ${If} $0 == "2"
    ${If} $R6 == ""
      MessageBox MB_OK|MB_ICONEXCLAMATION "The previous uninstaller can overwrite Windows hosts. To install in place, run this installer with /UPDATE. Setup saved recovery copies under %APPDATA%\Digital Habits Blocker\backups." /SD IDOK
    ${Else}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Setup needs to remove the older MSI installation, which can overwrite Windows hosts. Ask an administrator to review the legacy hosts entries and helper before retrying. Recovery copies are under %APPDATA%\Digital Habits Blocker\backups." /SD IDOK
    ${EndIf}
    SetErrorLevel 1
    Abort
  ${ElseIf} $0 != "0"
    MessageBox MB_OK|MB_ICONEXCLAMATION "Setup could not verify that the previous uninstaller can run safely. Review the installer details before retrying." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  ; Silent setup skips the maintenance page that deals with MSI
  ; migration. Refuse the duplicate install before touching the payload.
  ${If} ${Silent}
    Call FindWixInstall
    ${If} $R6 != ""
      DetailPrint "${SILENT_MSI_RECOVERY_MESSAGE}"
      System::Call 'kernel32::AttachConsole(i -1)i.r0'
      ${If} $0 <> 0
        System::Call 'kernel32::GetStdHandle(i -12)i.r0'
        FileWrite $0 "${SILENT_MSI_RECOVERY_MESSAGE}$\r$\n"
      ${EndIf}
      SetErrorLevel 1
      Abort
    ${EndIf}
  ${EndIf}

  ; Verify after same-product maintenance, then clean known renamed
  ; installs without executing their old uninstallers.
  InitPluginsDir
  File "/oname=$PLUGINSDIR\legacy-preinstall.ps1" "${LEGACY_PREINSTALL_PS1}"
  ${If} $HostsSnapshotFile == ""
    nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\legacy-preinstall.ps1"'
  ${Else}
    nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\legacy-preinstall.ps1" -SnapshotFile "$HostsSnapshotFile"'
  ${EndIf}
  Pop $0
  Delete "$PLUGINSDIR\legacy-preinstall.ps1"
  ${If} $0 != "0"
    MessageBox MB_OK|MB_ICONEXCLAMATION "Setup could not verify Windows hosts. Check the current hosts file and the recovery copies under %APPDATA%\Digital Habits Blocker\backups before retrying." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Always launch after install completes. The MUI finish page also has
  ; a "Run …" checkbox (default checked); if the user leaves it checked
  ; we'd briefly run the app twice — the tauri-plugin-single-instance
  ; plugin (registered in lib.rs) collapses any second instance into a
  ; focus-the-existing-window call, so this is safe.
  ;
  ; Why always-launch: on a v1.x → 2.0 upgrade the migration
  ; onboarding (full-screen overlay) only fires when the app is
  ; running. Skipping the launch leaves the user staring at a
  ; finished installer with no visible result, while v1.x's daemon
  ; stays alive and unsupervised in the background.
  Exec '"$INSTDIR\${MAINBINARYNAME}.exe"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Tauri calls this hook before its running-app check and before any
  ; file or app-data deletion. A failed legacy hosts cleanup (including
  ; cancelled elevation) must leave the app available for another try.
  ; The CLI checks legacy residue first, then removes our native
  ; messaging manifests and matching browser registry keys.
  ClearErrors
  ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --uninstall' $0
  ${If} ${Errors}
  ${OrIf} $0 <> 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "Cleanup could not finish. Retry and approve the administrator prompt if it appears. If the app executable is missing, repair the installation first." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}

  ; Remove the watchdog Scheduled Tasks so they don't respawn
  ;    redd-block.exe between the kill below and the actual file
  ;    deletion that NSIS does after this hook returns. Idempotent —
  ;    schtasks /Delete /F is silent if the task isn't present.
  nsExec::ExecToLog 'schtasks /Delete /TN "Digital Habits Blocker Watchdog" /F'
  Pop $0
  nsExec::ExecToLog 'schtasks /Delete /TN "ReDD Blocker Watchdog" /F'
  Pop $0
  nsExec::ExecToLog 'schtasks /Delete /TN "ReDD Block Watchdog" /F'
  Pop $0

  ; Best-effort pre-kill of the main app process so the built-in
  ;    running-app check usually doesn't need to show a second popup.
  !if "${INSTALLMODE}" == "currentUser"
    nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
  !else
    nsis_tauri_utils::FindProcess "${MAINBINARYNAME}.exe"
  !endif
  Pop $R0
  ${If} $R0 = 0
    !if "${INSTALLMODE}" == "currentUser"
      nsis_tauri_utils::KillProcessCurrentUser "${MAINBINARYNAME}.exe"
    !else
      nsis_tauri_utils::KillProcess "${MAINBINARYNAME}.exe"
    !endif
    Pop $R0
    Sleep 500
  ${EndIf}

  ; Note: 2.0 dropped v1.x's "Keep Blocking after uninstall" feature
  ; entirely (no daemon = no enforcement after the binary is removed).
  ; The user's blocklists / settings in ProgramData\<product>\
  ; redd-block-data.json are intentionally preserved so a future
  ; reinstall picks them back up — only the daemon-state file (now
  ; absent) and the helper-state.json are scrubbed during migration.
  ; Since the per-user migration that file is an import source only:
  ; each account copies
  ; it into its own %APPDATA%\com.reddblock\ store on first launch, so
  ; a shared PC no longer gives the whole family one blocklist.
!macroend
