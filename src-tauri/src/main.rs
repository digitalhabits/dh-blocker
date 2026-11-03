// Always use the Windows GUI subsystem so the installed app never shows
// a stray console window — closing the console kills the whole process
// tree, which is a footgun for users who run --debug installers for
// testing. Stdout/stderr aren't load-bearing: tauri-plugin-log mirrors
// to the app-data log file and to the webview DevTools console.
// On non-Windows targets the attribute is silently ignored.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    // Load local development configuration only in debug builds.
    #[cfg(debug_assertions)]
    {
        let _ = dotenvy::from_filename("../.env");
        let _ = dotenvy::dotenv();
    }

    // OS uninstallation retires app-owned registrations and legacy residue.
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    if std::env::args().skip(1).any(|a| a == "--uninstall") {
        let _ = redd_block_lib::native_host_install::uninstall();
        #[cfg(target_os = "windows")]
        {
            redd_block_lib::watchdog::unregister();
            redd_block_lib::windows_login::disable_autostart();
        }
        let _ = redd_block_lib::commands::migration::strip_hosts_markers_sync();
        let _ = redd_block_lib::commands::migration::uninstall_legacy_helper_sync();
        // Final cleanup: now that the user is uninstalling, the hosts
        // backups have served their purpose. Best-effort delete; on
        // macOS the legacy /etc/hosts.redd-backup needs root and will
        // be left for the user, but the in-app-data snapshots go.
        redd_block_lib::commands::migration::purge_legacy_backups_sync(None);
        std::process::exit(0);
    }

    redd_block_lib::run();
}
