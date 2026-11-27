// Manual end-to-end test harness for the v1.x → new-stack migration.
//
// Invokes the bundled elevated migration script directly, so we can
// verify the privileged step end-to-end without launching the full
// Tauri app + browser stack.
//
// Usage:
//   cd src-tauri
//   cargo run --example test_migration
//
// This binary is read-only on its own — it does NOT inject any v1.x
// residue. Use the companion shell harness in
// `scripts/test-migration.sh` to set up + tear down test residue.

use std::path::PathBuf;

use redd_block_lib::commands::migration::{migration_pending_sync, run_elevated_migration};

fn app_data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        PathBuf::from(std::env::var("APPDATA").expect("APPDATA not set")).join("com.reddblock")
    }
    #[cfg(target_os = "macos")]
    {
        PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
            .join("Library/Application Support/com.reddblock")
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        std::env::temp_dir().join("com.reddblock")
    }
}

fn inject_hint() -> &'static str {
    if cfg!(target_os = "windows") {
        "  scripts/test-migration.ps1 inject"
    } else {
        "  scripts/test-migration.sh inject"
    }
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp(None)
        .init();
    println!("=== Fristed migration harness ===");
    println!("residue present? {}", migration_pending_sync());
    let app_data = app_data_dir();
    println!("app-data dir: {}", app_data.display());

    if !migration_pending_sync() {
        println!("Nothing to migrate. Inject residue first via:");
        println!("{}", inject_hint());
        return;
    }

    println!();
    println!("Running elevated migration. You should see ONE admin prompt.");
    let outcome = run_elevated_migration(Some(&app_data));
    println!();
    println!(
        "Outcome: success={} user_cancelled={}",
        outcome.success, outcome.user_cancelled
    );
    println!("residue still present? {}", migration_pending_sync());

    let backups_dir = app_data.join("backups");
    if backups_dir.exists() {
        println!("Snapshots in {}:", backups_dir.display());
        if let Ok(entries) = std::fs::read_dir(&backups_dir) {
            for entry in entries.flatten() {
                let len = entry.metadata().map(|m| m.len()).unwrap_or(0);
                println!("  {} ({} bytes)", entry.file_name().to_string_lossy(), len);
            }
        }
    } else {
        println!("(no app-data snapshots written)");
    }
}
