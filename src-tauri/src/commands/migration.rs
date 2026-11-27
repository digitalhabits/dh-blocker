// First-launch migration off the v1.x privileged-helper stack.
//
// Goal: strip the daemon-managed lines from the system hosts file and
// remove the legacy launchd plist / scheduled task + helper binary,
// in a way that is safe, atomic, and reversible if something goes
// wrong mid-flight.
//
// Design (matches the approved plan in the planning file):
//
// Prepare an edit from the live hosts file and keep its original bytes in
// a recovery snapshot. The elevated script stops the helper, verifies the
// hosts file still matches those bytes, and replaces it when an edit is
// needed. Only then does it remove the helper's persistent files and
// write a success marker. Both the new and legacy backups are retained.
//
// A failure leaves the migration pending for retry. A failure after the
// hosts edit leaves the recovery snapshot intact.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI8, Ordering};

use serde::Serialize;

// Snapshot of "was migration pending when this process launched?".
// Lazily computed on first read, then frozen for the rest of the
// process. Lets the frontend distinguish "fresh install" from
// "we just upgraded" even after the migration script has cleared
// the residue mid-launch.
//
// Encoded as: -1 = uninitialised, 0 = false, 1 = true.
static MIGRATION_WAS_PENDING_AT_LAUNCH: AtomicI8 = AtomicI8::new(-1);
static SNAPSHOT_INIT: AtomicBool = AtomicBool::new(false);

#[cfg(feature = "system-test")]
fn snapshot_initial_state() -> bool {
    false
}

#[cfg(not(feature = "system-test"))]
fn snapshot_initial_state() -> bool {
    if SNAPSHOT_INIT.load(Ordering::Acquire) {
        return MIGRATION_WAS_PENDING_AT_LAUNCH.load(Ordering::Acquire) == 1;
    }
    let pending = migration_pending_uncached();
    let val = if pending { 1 } else { 0 };
    let _ = MIGRATION_WAS_PENDING_AT_LAUNCH.compare_exchange(
        -1,
        val,
        Ordering::AcqRel,
        Ordering::Acquire,
    );
    SNAPSHOT_INIT.store(true, Ordering::Release);
    MIGRATION_WAS_PENDING_AT_LAUNCH.load(Ordering::Acquire) == 1
}

const BEGIN_MARKER: &[u8] = b"# === BEGIN REDD BLOCK (reddfocus.org) ===";
const END_MARKER: &[u8] = b"# === END REDD BLOCK (reddfocus.org) ===";
const LEGACY_BEGIN: &[u8] = b"# ReDD Block Start";
const LEGACY_END: &[u8] = b"# ReDD Block End";
const UTF8_BOM: &[u8] = b"\xef\xbb\xbf";

#[cfg(all(
    not(feature = "system-test"),
    any(target_os = "macos", target_os = "windows")
))]
const STATUS_OK: &str = "ok";

// ---- Detection -----------------------------------------------------------

fn hosts_path() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        PathBuf::from(r"C:\Windows\System32\drivers\etc\hosts")
    }
    #[cfg(not(target_os = "windows"))]
    {
        PathBuf::from("/etc/hosts")
    }
}

fn legacy_hosts_backup_path() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        PathBuf::from(r"C:\Windows\System32\drivers\etc\hosts.redd-backup")
    }
    #[cfg(not(target_os = "windows"))]
    {
        PathBuf::from("/etc/hosts.redd-backup")
    }
}

fn hosts_has_markers(content: &[u8]) -> bool {
    let body = content.strip_prefix(UTF8_BOM).unwrap_or(content);
    body.split_inclusive(|&byte| byte == b'\n').any(|line| {
        matches!(
            trim_marker_line(line),
            BEGIN_MARKER | END_MARKER | LEGACY_BEGIN | LEGACY_END
        )
    })
}

fn trim_marker_line(line: &[u8]) -> &[u8] {
    let start = line.iter().position(|byte| !byte.is_ascii_whitespace());
    let end = line.iter().rposition(|byte| !byte.is_ascii_whitespace());
    match (start, end) {
        (Some(start), Some(end)) => &line[start..=end],
        _ => &[],
    }
}

fn legacy_artefacts_present() -> bool {
    // We only count daemon-specific files as residue. The shared data
    // dir (/var/lib/redd-block on macOS, ProgramData\<product> on
    // Windows) intentionally stays: nothing writes it any more, but
    // commands::data::import_shared_data_into_per_user still reads the
    // user's redd-block-data.json out of it, and accounts that have not
    // launched the new build yet have not imported theirs.
    #[cfg(target_os = "macos")]
    {
        let paths = [
            "/Library/LaunchDaemons/com.redd.block.helper.plist",
            "/Library/LaunchDaemons/org.reddfocus.redd-block-helper.plist",
            "/Library/PrivilegedHelperTools/com.redd.block.helper",
            "/var/lib/redd-block/helper-state.json",
        ];
        paths.iter().any(|p| Path::new(p).exists())
    }
    #[cfg(target_os = "windows")]
    {
        let mut dirs = crate::product_identity::windows_legacy_shared_dirs();
        dirs.push(crate::product_identity::windows_primary_shared_dir());
        dirs.iter()
            .any(|dir| dir.join("helper-state.json").exists())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        false
    }
}

/// Returns true when there's any v1.x residue (hosts markers or
/// legacy artefacts) the migration still needs to clean up. Also
/// memoises the answer at first call so we can later report what
/// the state was at process launch (for the frontend's "we just
/// upgraded, show the welcome" gate).
pub fn migration_pending_sync() -> bool {
    let _ = snapshot_initial_state();
    migration_pending_uncached()
}

#[cfg(feature = "system-test")]
fn migration_pending_uncached() -> bool {
    false
}

#[cfg(not(feature = "system-test"))]
fn migration_pending_uncached() -> bool {
    match std::fs::read(hosts_path()) {
        Ok(raw) if hosts_has_markers(&raw) => return true,
        Err(e) if cfg!(any(target_os = "macos", target_os = "windows")) => {
            log::warn!("unable to check hosts for migration residue: {e}");
            return true;
        }
        _ => {}
    }
    legacy_artefacts_present()
}

#[tauri::command]
pub fn migration_pending() -> bool {
    migration_pending_sync()
}

/// True if there was v1.x residue when the process started, even if
/// the migration has since cleaned it up. The frontend uses this to
/// decide whether to show the post-cleanup "welcome to 2.0" screen.
#[tauri::command]
pub fn migration_was_pending_at_launch() -> bool {
    snapshot_initial_state()
}

/// True if this install has *ever* hosted the v1.x privileged
/// daemon — durable signal across launches, surviving the cleanup.
/// We use the existence of `/etc/hosts.redd-backup` (or its Windows
/// equivalent) as the fingerprint: that file is only ever written
/// by the v1.x daemon's `ensure_backup_exists` and is intentionally
/// preserved by the migration as a recovery copy. The frontend uses
/// it to decide whether to surface a persistent "behaviour has
/// changed" banner for upgraders, separate from the one-time
/// welcome overlay.
#[cfg(feature = "system-test")]
#[tauri::command]
pub fn user_came_from_v1x() -> bool {
    false
}

#[cfg(not(feature = "system-test"))]
#[tauri::command]
pub fn user_came_from_v1x() -> bool {
    legacy_hosts_backup_path().exists()
}

// ---- Hosts cleaning (pure) ----------------------------------------------

#[cfg(any(
    test,
    all(
        not(feature = "system-test"),
        any(target_os = "macos", target_os = "windows")
    )
))]
fn strip_managed_sections(content: &[u8]) -> Result<Vec<u8>, &'static str> {
    let mut out = Vec::with_capacity(content.len());
    let body = if let Some(body) = content.strip_prefix(UTF8_BOM) {
        out.extend_from_slice(UTF8_BOM);
        body
    } else {
        content
    };

    // Match full, same-generation pairs. Bail out on ambiguity rather
    // than treating intervening user entries as ours.
    let mut expected_end = None;
    for line in body.split_inclusive(|&byte| byte == b'\n') {
        match trim_marker_line(line) {
            BEGIN_MARKER if expected_end.is_none() => expected_end = Some(END_MARKER),
            LEGACY_BEGIN if expected_end.is_none() => expected_end = Some(LEGACY_END),
            end @ (END_MARKER | LEGACY_END) if expected_end == Some(end) => expected_end = None,
            BEGIN_MARKER | END_MARKER | LEGACY_BEGIN | LEGACY_END => {
                return Err("unpaired or nested ReDD Block hosts marker");
            }
            _ if expected_end.is_none() => out.extend_from_slice(line),
            _ => {}
        }
    }
    if expected_end.is_some() {
        return Err("missing end marker for ReDD Block hosts section");
    }
    Ok(out)
}

#[cfg(any(
    test,
    all(
        not(feature = "system-test"),
        any(target_os = "macos", target_os = "windows")
    )
))]
fn compute_cleaned_hosts(live: &[u8]) -> Result<Vec<u8>, &'static str> {
    let cleaned = strip_managed_sections(live)?;
    if cleaned != live
        && !cleaned
            .windows(b"localhost".len())
            .any(|w| w == b"localhost")
    {
        return Err("refusing to write hosts without localhost".into());
    }
    Ok(cleaned)
}

// ---- Public commands -----------------------------------------------------

/// Clean up legacy hosts markers using the bundled migration.
#[tauri::command]
pub async fn strip_hosts_markers() -> Result<bool, String> {
    if !migration_pending_sync() {
        return Ok(false);
    }
    let outcome = run_elevated_migration(None);
    Ok(outcome.success)
}

#[tauri::command]
pub async fn uninstall_legacy_helper() -> Result<bool, String> {
    if !migration_pending_sync() {
        return Ok(true);
    }
    let outcome = run_elevated_migration(None);
    Ok(outcome.success)
}

/// Check for legacy residue, try the same cleanup as upgrade once, and
/// verify it before the uninstaller removes the app.
pub fn cleanup_legacy_for_uninstall() -> Result<(), String> {
    if !migration_pending_sync() {
        return Ok(());
    }
    let outcome = run_elevated_migration(None);
    if outcome.user_cancelled {
        return Err(
            "Administrator approval is required to remove the legacy hosts entries and helper."
                .into(),
        );
    }
    if !outcome.success || migration_pending_sync() {
        return Err("Could not verify removal of the legacy hosts entries and helper.".into());
    }
    Ok(())
}

// ---- Onboarding orchestration --------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct OnboardingState {
    /// True if this build migrated anything in this launch
    /// (hosts cleaned, helper removed, autostart registered).
    pub migrated_this_launch: bool,
    /// True when v1.x residue (markers or legacy artefacts) is still
    /// present. Drives the "Migration incomplete" banner. False on
    /// fresh installs and after a successful migration.
    pub migration_pending: bool,
    /// True for users crossing the v1 → v2 architecture boundary in
    /// this launch. Drives the one-time "what's new" welcome card.
    pub show_upgrade_welcome: bool,
    /// True when every running-and-present browser has a compliant
    /// default profile.
    pub extension_compliant: bool,
    /// Detailed per-browser scan.
    pub browsers: crate::profile_scan::ScanResult,
}

#[derive(Debug, Clone, Copy)]
pub struct ElevatedOutcome {
    pub success: bool,
    /// True when the user cancelled the admin prompt (no destructive
    /// action attempted). Used by the frontend to soften the banner
    /// wording.
    pub user_cancelled: bool,
}

// A system-test app must never inspect or mutate the host's legacy
// hosts/daemon installation. Its data path is isolated, but the legacy
// migration operates on global system files, so make this command a
// deliberate no-op for that build.
#[cfg(feature = "system-test")]
#[tauri::command]
pub async fn run_upgrade_migration(_app: tauri::AppHandle) -> Result<bool, String> {
    Ok(true)
}

#[cfg(not(feature = "system-test"))]
#[tauri::command]
pub async fn run_upgrade_migration(app: tauri::AppHandle) -> Result<bool, String> {
    let Some(data_path) = super::data::canonical_data_path(&app) else {
        return Ok(false);
    };

    // Legacy residue can reappear even after the version was stamped.
    if migration_pending_sync() {
        let outcome = run_elevated_migration(None);
        if !outcome.success {
            return Ok(false);
        }
        if migration_pending_sync() {
            log::warn!("elevated migration returned ok but residue is still present");
            return Ok(false);
        }
    }

    #[cfg(not(target_os = "macos"))]
    if let Err(e) = crate::native_host_install::install() {
        log::warn!("native-host install during migration failed: {e}");
    }

    if let Err(e) = stamp_version(&data_path, env!("CARGO_PKG_VERSION")) {
        log::warn!("failed to persist migrationRanAtVersion at {data_path:?}: {e}");
    }
    Ok(true)
}

#[tauri::command]
pub async fn onboarding_state(_app: tauri::AppHandle) -> Result<OnboardingState, String> {
    // PURE state report — does NOT trigger run_upgrade_migration.
    // Migration is invoked explicitly by the frontend (Continue
    // button on the pre-cleanup screen, or the retry CTA). If we
    // re-ran migration here we'd loop admin prompts every time the
    // window regains focus, since the post-cleanup screen polls this
    // command to refresh the per-browser checklist.
    let migration_pending = migration_pending_sync();
    // "We just upgraded this launch": there was residue at process
    // start, but it's now cleaned up. Persists for the lifetime of
    // the process via snapshot_initial_state.
    let show_upgrade_welcome = snapshot_initial_state() && !migration_pending;
    let migrated_this_launch = show_upgrade_welcome;

    let browsers = tauri::async_runtime::spawn_blocking(crate::profile_scan::scan_for_onboarding)
        .await
        .map_err(|e| e.to_string())?;
    let extension_compliant = crate::profile_scan::compliant(&browsers);

    Ok(OnboardingState {
        migrated_this_launch,
        migration_pending,
        show_upgrade_welcome,
        extension_compliant,
        browsers,
    })
}

// ---- Elevated execution --------------------------------------------------

/// Runs the bundled elevated migration script and verifies its completion.
/// With no app-data directory, use a persistent per-user recovery location.
#[cfg(all(
    not(feature = "system-test"),
    any(target_os = "macos", target_os = "windows")
))]
pub fn run_elevated_migration(app_data_dir: Option<&Path>) -> ElevatedOutcome {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let file_suffix = format!("{timestamp}.{}", std::process::id());
    let prepared = match prepare_hosts_edit(app_data_dir, &file_suffix) {
        Ok(prepared) => prepared,
        Err(e) => {
            log::warn!("migration aborted before prompt: {e}");
            return ElevatedOutcome {
                success: false,
                user_cancelled: false,
            };
        }
    };

    let status_path = std::env::temp_dir().join(format!("redd-migration-status.{file_suffix}"));
    // Best-effort cleanup of any stale prior status file.
    let _ = std::fs::remove_file(&status_path);
    log::info!(
        "migration: status marker target = {}",
        status_path.display()
    );

    #[cfg(target_os = "macos")]
    let outcome = run_elevated_macos(&prepared, &status_path);
    #[cfg(target_os = "windows")]
    let outcome = run_elevated_windows(&prepared, &status_path);
    let _ = std::fs::remove_file(&prepared.staged);

    // Final gate: the elevated script writes STATUS_OK only after
    // every ordered step succeeded. If the marker is missing, treat
    // this as a failure even if the process returned 0 for some
    // reason (e.g. PowerShell -Verb RunAs returning prematurely).
    let marker_read = std::fs::read_to_string(&status_path);
    let marker_ok = match &marker_read {
        Ok(s) => s.trim() == STATUS_OK,
        Err(_) => false,
    };
    if !marker_ok {
        match marker_read {
            Ok(s) => log::warn!(
                "migration: status marker present but wrong content: {:?}",
                s
            ),
            Err(e) => log::warn!(
                "migration: could not read status marker at {}: {} (success={}, user_cancelled={})",
                status_path.display(),
                e,
                outcome.success,
                outcome.user_cancelled
            ),
        }
    }
    let _ = std::fs::remove_file(&status_path);
    if !marker_ok {
        return ElevatedOutcome {
            success: false,
            ..outcome
        };
    }

    outcome
}

#[cfg(any(
    feature = "system-test",
    not(any(target_os = "macos", target_os = "windows"))
))]
pub fn run_elevated_migration(_app_data_dir: Option<&Path>) -> ElevatedOutcome {
    ElevatedOutcome {
        success: false,
        user_cancelled: false,
    }
}

#[cfg(all(
    not(feature = "system-test"),
    any(target_os = "macos", target_os = "windows")
))]
struct PreparedHostsEdit {
    staged: PathBuf,
    live_hash: String,
    cleaned_hash: String,
}

#[cfg(all(
    not(feature = "system-test"),
    any(target_os = "macos", target_os = "windows")
))]
fn prepare_hosts_edit(
    app_data_dir: Option<&Path>,
    file_suffix: &str,
) -> Result<PreparedHostsEdit, String> {
    use sha2::{Digest, Sha256};
    use std::io::Write;

    let live = std::fs::read(hosts_path()).map_err(|e| format!("read hosts: {e}"))?;
    let cleaned = compute_cleaned_hosts(&live)?;
    if cleaned != live {
        let backup_dir = app_data_dir
            .map(|dir| dir.join("backups"))
            .or_else(default_backup_dir)
            .ok_or("could not resolve hosts recovery directory")?;
        std::fs::create_dir_all(&backup_dir).map_err(|e| format!("create recovery dir: {e}"))?;
        let snapshot = backup_dir.join(format!("hosts.{file_suffix}"));
        let mut file = std::fs::File::create_new(&snapshot)
            .map_err(|e| format!("open hosts snapshot at {snapshot:?}: {e}"))?;
        if let Err(e) = file.write_all(&live).and_then(|()| file.sync_all()) {
            drop(file);
            let _ = std::fs::remove_file(&snapshot);
            return Err(format!("save hosts snapshot at {snapshot:?}: {e}"));
        }
    }

    let staged = std::env::temp_dir().join(format!("redd-hosts-cleaned.{file_suffix}"));
    let mut file =
        std::fs::File::create_new(&staged).map_err(|e| format!("open staged hosts: {e}"))?;
    if let Err(e) = file.write_all(&cleaned) {
        drop(file);
        let _ = std::fs::remove_file(&staged);
        return Err(format!("write staged hosts: {e}"));
    }
    Ok(PreparedHostsEdit {
        staged,
        live_hash: format!("{:x}", Sha256::digest(&live)),
        cleaned_hash: format!("{:x}", Sha256::digest(&cleaned)),
    })
}

#[cfg(all(not(feature = "system-test"), target_os = "macos"))]
fn default_backup_dir() -> Option<PathBuf> {
    // Keep snapshots outside the directories targeted by wipe_user_data.
    dirs::data_dir().map(|dir| {
        dir.join(crate::product_identity::PRODUCT_DIR_NAME)
            .join("backups")
    })
}

#[cfg(all(not(feature = "system-test"), target_os = "windows"))]
fn default_backup_dir() -> Option<PathBuf> {
    // The NSIS delete-app-data checkbox removes the bundle-ID directories.
    // Hosts recovery snapshots sit beside those directories.
    crate::product_identity::windows_primary_local_product_dir().map(|dir| dir.join("backups"))
}

#[cfg(all(not(feature = "system-test"), target_os = "macos"))]
fn run_elevated_macos(edit: &PreparedHostsEdit, status_path: &Path) -> ElevatedOutcome {
    use std::process::Command;

    // set -e stops the shell script at a failed gate.
    //
    // The shell script writes STATUS_OK to the status file only if it
    // reaches the end with no failure. Rust reads that marker after
    // the process exits.
    let staged_str = edit.staged.display().to_string();
    let status_str = status_path.display().to_string();

    // Shell escape: the paths contain only timestamp / temp-dir
    // characters, so single-quoting is safe. Reject anything weird
    // up front to be defensive.
    if staged_str.contains('\'') || status_str.contains('\'') {
        log::warn!("migration aborted: unexpected quote in staged paths");
        return ElevatedOutcome {
            success: false,
            user_cancelled: false,
        };
    }

    // Script body lives in a sibling .sh file so it can be edited
    // with shell syntax highlighting, linted with shellcheck, and
    // tested in isolation. STATUS_OK is hard-coded in the script (must stay in
    // sync with the Rust constant — both equal "ok").
    const SCRIPT_TEMPLATE: &str = include_str!("migration/cleanup.sh");
    debug_assert_eq!(STATUS_OK, "ok", "cleanup.sh hard-codes 'ok'");
    let inner = SCRIPT_TEMPLATE
        .replace("{STAGED}", &staged_str)
        .replace("{STATUS}", &status_str)
        .replace("{LIVE_HASH}", &edit.live_hash)
        .replace("{CLEANED_HASH}", &edit.cleaned_hash);

    // Wrap in osascript do shell script. Single admin prompt for the
    // user. The prompt wording mentions both pieces of work so the
    // user knows what they're approving.
    let escaped = inner.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        r#"do shell script "{}" with administrator privileges with prompt "Digital Habits: Blocker needs to clean up the old hosts-file entries and remove the legacy helper.""#,
        escaped
    );

    match Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .output()
    {
        Ok(out) => {
            if out.status.success() {
                ElevatedOutcome {
                    success: true,
                    user_cancelled: false,
                }
            } else {
                let stderr = String::from_utf8_lossy(&out.stderr);
                // osascript returns -128 / "User cancelled" when the
                // user clicks Cancel on the admin prompt.
                let cancelled = stderr.contains("User cancelled") || stderr.contains("-128");
                if !cancelled {
                    log::warn!("elevated migration script failed: {}", stderr.trim());
                }
                ElevatedOutcome {
                    success: false,
                    user_cancelled: cancelled,
                }
            }
        }
        Err(e) => {
            log::warn!("failed to launch osascript: {e}");
            ElevatedOutcome {
                success: false,
                user_cancelled: false,
            }
        }
    }
}

#[cfg(all(not(feature = "system-test"), target_os = "windows"))]
fn run_elevated_windows(edit: &PreparedHostsEdit, status_path: &Path) -> ElevatedOutcome {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    // CREATE_NO_WINDOW: keep the outer (non-elevated) launcher invisible.
    // The inner elevated PowerShell is hidden separately via -WindowStyle.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let staged_str = edit.staged.display().to_string();
    let status_str = status_path.display().to_string();

    // PowerShell with $ErrorActionPreference='Stop' so any failure
    // aborts the script before destructive steps. Single UAC prompt
    // via `Start-Process -Verb RunAs`.
    //
    // The outer call writes the inner script to a temp file (so we
    // don't have to deal with double-quote escaping through two
    // PowerShell invocations) and runs it elevated, waiting for it
    // to exit so we can read the status marker.
    // Same pattern as macOS: script body in a sibling .ps1 file so
    // it can be edited with PowerShell syntax highlighting, linted
    // with PSScriptAnalyzer, and tested in isolation.
    const SCRIPT_TEMPLATE: &str = include_str!("migration/cleanup.ps1");
    debug_assert_eq!(STATUS_OK, "ok", "cleanup.ps1 hard-codes 'ok'");
    let inner_script = SCRIPT_TEMPLATE
        .replace("{STAGED}", &staged_str.replace('\'', "''"))
        .replace("{STATUS}", &status_str.replace('\'', "''"))
        .replace("{LIVE_HASH}", &edit.live_hash)
        .replace("{CLEANED_HASH}", &edit.cleaned_hash);

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let inner_path = std::env::temp_dir().join(format!("redd-migration.{timestamp}.ps1"));
    if let Err(e) = std::fs::write(&inner_path, inner_script) {
        log::warn!("failed to stage windows migration script: {e}");
        return ElevatedOutcome {
            success: false,
            user_cancelled: false,
        };
    }

    // Outer launcher: spawn elevated PowerShell to run the inner
    // script and wait. Capture exit code; UAC cancellation surfaces
    // as a launch error from Start-Process -Verb RunAs.
    let launcher = format!(
        r#"$ErrorActionPreference = 'Stop'
try {{
  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy','Bypass',
    '-WindowStyle','Hidden', '-File','"{inner}"'
  ) -Verb RunAs -WindowStyle Hidden -PassThru -Wait
  exit $p.ExitCode
}} catch {{
  # User cancelled UAC, or other launch failure.
  exit 1223
}}
"#,
        inner = inner_path.display().to_string().replace('\'', "''"),
    );

    let outcome = match Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &launcher,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        Ok(out) => {
            // Windows uses exit code 1223 (ERROR_CANCELLED) for "user
            // declined elevation". We synthesise the same code for
            // the catch branch above.
            let code = out.status.code().unwrap_or(-1);
            let cancelled = code == 1223;
            let success = code == 0;
            if !success && !cancelled {
                log::warn!(
                    "elevated migration powershell failed: code={} stderr={}",
                    code,
                    String::from_utf8_lossy(&out.stderr).trim()
                );
            }
            ElevatedOutcome {
                success,
                user_cancelled: cancelled,
            }
        }
        Err(e) => {
            log::warn!("failed to launch powershell: {e}");
            ElevatedOutcome {
                success: false,
                user_cancelled: false,
            }
        }
    };

    let _ = std::fs::remove_file(&inner_path);
    outcome
}

// ---- Settings persistence -----------------------------------------------

#[cfg(not(feature = "system-test"))]
fn stamp_version(path: &Path, current: &str) -> Result<(), String> {
    // Read after elevation and hold the same lock as regular saves until
    // the atomic replacement. Never turn malformed or missing data into
    // a settings-only file.
    let transaction = super::data::DataFileWrite::lock(path).map_err(|e| e.to_string())?;
    let raw = match std::fs::read(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    let mut data: serde_json::Map<String, serde_json::Value> =
        serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    let settings = data
        .entry("settings")
        .or_insert_with(|| serde_json::Value::Object(Default::default()))
        .as_object_mut()
        .ok_or("settings must be an object")?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64);
    settings.insert("migrationRanAtVersion".to_string(), current.into());
    settings.insert("migrationRanAt".to_string(), now.into());

    let body = serde_json::to_vec_pretty(&data).map_err(|e| e.to_string())?;
    transaction.write(&body).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests;
