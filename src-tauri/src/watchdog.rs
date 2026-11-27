// Legacy Windows watchdog diagnostics and cleanup.
// New tasks and script wrappers are no longer created (Defender issue #152).
// The Store cannot run an uninstaller hook, so retire its tasks on upgrade.

use std::path::{Path, PathBuf};

use crate::windows_process::hidden_command;

pub const TASK_NAME: &str = crate::product_identity::WATCHDOG_TASK_NAME;
const WRAPPER_CMD_FILENAME: &str = "redd-block-watchdog.cmd";
const WRAPPER_VBS_FILENAME: &str = "redd-block-watchdog.vbs";

fn wrapper_dir(exe: &Path) -> Option<PathBuf> {
    if crate::native_host_install::is_msix_packaged_exe_path(exe) {
        Some(crate::product_identity::windows_primary_local_product_dir()?.join("watchdog"))
    } else {
        exe.parent().map(|p| p.to_path_buf())
    }
}

fn delete_task(name: &str) {
    let _ = hidden_command("schtasks")
        .args(["/Delete", "/TN", name, "/F"])
        .output();
}

fn delete_legacy_tasks() {
    for name in crate::product_identity::LEGACY_WATCHDOG_TASK_NAMES {
        delete_task(name);
    }
}

#[cfg(not(feature = "system-test"))]
pub(crate) fn retire_store_tasks() {
    use windows::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
    use windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFamilyName;

    let mut length = 0;
    if unsafe { GetCurrentPackageFamilyName(&mut length, None) } != ERROR_INSUFFICIENT_BUFFER {
        return;
    }

    std::thread::spawn(|| {
        let output = crate::windows_process::system_directory().and_then(|dir| {
            hidden_command(dir.join(r"WindowsPowerShell\v1.0\powershell.exe"))
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    include_str!("../windows/store-watchdog-cleanup.ps1"),
                ])
                .output()
        });
        match output {
            Ok(output) if output.status.success() => {
                let message = String::from_utf8_lossy(&output.stdout);
                if !message.trim().is_empty() {
                    log::info!("watchdog: {}", message.trim());
                }
            }
            Ok(output) => log::warn!(
                "watchdog: Store task cleanup failed ({}): {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ),
            Err(e) => log::warn!("watchdog: could not launch Store task cleanup: {e}"),
        }
    });
}

/// True if the per-user Scheduled Task is currently registered with
/// the Task Scheduler. Best-effort — failures (schtasks not found,
/// permission denied) are treated as "not present" rather than
/// crashing the diagnostics readout.
pub fn is_registered() -> bool {
    hidden_command("schtasks")
        .args(["/Query", "/TN", TASK_NAME])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Idempotent: removes the task and both wrapper scripts if present.
pub fn unregister() {
    delete_task(TASK_NAME);
    delete_legacy_tasks();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = wrapper_dir(&exe) {
            let _ = std::fs::remove_file(dir.join(WRAPPER_CMD_FILENAME));
            let _ = std::fs::remove_file(dir.join(WRAPPER_VBS_FILENAME));
        }
        // Also scrub legacy MSIX wrapper dirs from prior product folder names.
        for legacy in crate::product_identity::windows_legacy_local_product_dirs() {
            let dir = legacy.join("watchdog");
            let _ = std::fs::remove_file(dir.join(WRAPPER_CMD_FILENAME));
            let _ = std::fs::remove_file(dir.join(WRAPPER_VBS_FILENAME));
        }
    }
}
