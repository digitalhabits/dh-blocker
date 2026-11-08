// Always use the Windows GUI subsystem so the installed app never shows
// a stray console window — closing the console kills the whole process
// tree, which is a footgun for users who run --debug installers for
// testing. Stdout/stderr aren't load-bearing: tauri-plugin-log mirrors
// to the app-data log file and to the webview DevTools console.
// On non-Windows targets the attribute is silently ignored.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    // Debug builds load `.env` from the workspace root so dev-only
    // settings (REDD_DEV_EXT_ID, etc.) are picked up by `pnpm dev`,
    // direct `cargo run`, and the browser-spawned native-host process
    // alike. Production builds skip this entirely — release users
    // should never have a `.env` adjacent to the bundle anyway.
    #[cfg(debug_assertions)]
    {
        let _ = dotenvy::from_filename("../.env");
        let _ = dotenvy::dotenv();
    }

    // When invoked by a browser as a native-messaging host, branch
    // into the stdio loop before Tauri tries to start a UI. The flag
    // is passed to the binary by the browser when it spawns us via the
    // native-messaging manifest.
    #[cfg(not(target_os = "ios"))]
    if redd_block_lib::native_host::is_native_host_invocation() {
        #[cfg(target_os = "windows")]
        redd_block_lib::windows_process::set_native_host_process_directory();
        redd_block_lib::native_host::run();
    }

    // `--uninstall` tears down per-browser native-messaging manifests,
    // External-Extensions install hints, the Windows watchdog Scheduled
    // Task, and any leftover legacy-helper artefacts, then exits.
    // Called from the NSIS pre-uninstall hook on Windows; also useful
    // for an `Uninstall.app` shim or a manual `redd-block --uninstall`.
    #[cfg(not(target_os = "ios"))]
    if std::env::args().skip(1).any(|a| a == "--uninstall") {
        let _ = redd_block_lib::native_host_install::uninstall();
        let _ = redd_block_lib::extension_install::uninstall();
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
