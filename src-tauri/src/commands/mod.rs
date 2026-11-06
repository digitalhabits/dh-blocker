mod data;

#[cfg(not(target_os = "ios"))]
pub mod app_blocking;
#[cfg(not(target_os = "ios"))]
mod app_update;
#[cfg(not(target_os = "ios"))]
mod apps;
#[cfg(not(target_os = "ios"))]
mod blocking_method_cmd;
#[cfg(not(target_os = "ios"))]
mod browser_ext;
#[cfg(not(target_os = "ios"))]
pub mod diagnostics;
#[cfg(not(target_os = "ios"))]
pub mod enforcement;
#[cfg(not(target_os = "ios"))]
pub mod enforcement_toggle;
#[cfg(not(target_os = "ios"))]
pub mod grace;
#[cfg(not(target_os = "ios"))]
mod helper_shim;
#[cfg(not(target_os = "ios"))]
pub mod migration;
#[cfg(not(target_os = "ios"))]
mod overlay_assets;
#[cfg(not(target_os = "ios"))]
pub mod safari_bridge;
#[cfg(target_os = "macos")]
pub mod uninstall;
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
#[cfg(not(target_os = "ios"))]
#[allow(ambiguous_glob_reexports)]
pub use app_blocking::*;
#[cfg(not(target_os = "ios"))]
pub use app_update::*;
#[cfg(not(target_os = "ios"))]
pub use apps::*;
#[cfg(not(target_os = "ios"))]
pub use blocking_method_cmd::*;
#[cfg(not(target_os = "ios"))]
pub use browser_ext::*;
#[cfg(not(target_os = "ios"))]
pub use diagnostics::*;
#[cfg(not(target_os = "ios"))]
#[allow(ambiguous_glob_reexports)]
pub use enforcement::*;
#[cfg(not(target_os = "ios"))]
pub use enforcement_toggle::*;
#[cfg(not(target_os = "ios"))]
pub use grace::*;
#[cfg(not(target_os = "ios"))]
pub use helper_shim::*;
#[cfg(not(target_os = "ios"))]
pub use migration::*;
#[cfg(not(target_os = "ios"))]
pub use overlay_assets::*;
#[cfg(not(target_os = "ios"))]
pub use safari_bridge::*;
#[cfg(target_os = "macos")]
pub use uninstall::*;
#[cfg(target_os = "macos")]
pub use web_automation::*;
