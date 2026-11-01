mod data;

#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod app_blocking;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod app_update;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod apps;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod diagnostics;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod helper_shim;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod migration;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod overlay_assets;
#[cfg(target_os = "macos")]
pub mod uninstall;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod window_shell;
// Not glob re-exported: its `register` / `auto_start` would collide with
// `web_automation`'s in the globs below. Call sites use the qualified path.
#[cfg(target_os = "macos")]
pub mod firefox_ax;
#[cfg(target_os = "macos")]
pub mod web_automation;

pub use data::*;

// `register` / `auto_start` exist in both app_blocking and web_automation (and
// enforcement). Every call site uses the qualified module path, so nothing
// depends on which glob wins. Keep these globs because Tauri's generated
// `__cmd__*` symbols must be re-exported alongside the command functions.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
#[allow(ambiguous_glob_reexports)]
pub use app_blocking::*;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub use app_update::*;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub use apps::*;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub use diagnostics::*;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub use helper_shim::*;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub use migration::*;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub use overlay_assets::*;
#[cfg(target_os = "macos")]
pub use uninstall::*;
#[cfg(target_os = "macos")]
pub use web_automation::*;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub use window_shell::*;
