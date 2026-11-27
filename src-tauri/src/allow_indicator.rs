//! The allow-mode indicator: a small always-on-top window that lists what
//! the running allow-mode focus spaces leave available.
//!
//! **Display only.** Nothing here feeds enforcement, and nothing enforcement
//! does depends on it. The window has no pause or stop control, and hiding
//! it (the ✕, or `settings.showAllowIndicator = false`) changes nothing
//! about what is blocked. Keep it that way: a control on a surface that
//! floats over every app would be the cheapest bypass in the product.
//!
//! The list is derived from `native_host::derive_payload`, the same blocks
//! the website watchers enforce, so it cannot drift from them on its own.
//! It runs from Rust rather than the main webview because the main window
//! is destroyed on close while enforcement carries on in the tray.
//!
//! **Which way failures fall:** towards not showing. If the data file will
//! not parse, or the window cannot be built, the indicator stays hidden and
//! blocking is unaffected. A list that might be wrong is worse than none.
//!
//! Window technique follows the To-Do focus window (planner repo,
//! `apps/todo/src-tauri/src/focus.rs`): an `NSPanel` on macOS so it floats
//! over full-screen apps and every Space without activating Blocker; a
//! borderless always-on-top window on Windows. Unlike that window it never
//! becomes key: it takes no keyboard input, so hovering or clicking it must
//! not pull typing away from the app the user is working in.

use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

use crate::native_host::{self, BlockInfo};

pub const WINDOW_LABEL: &str = "allow-indicator";
const STATE_EVENT: &str = "allow-indicator-state";
/// Sent when the window is hidden, so it reopens as the small pill rather
/// than however it was left.
const RESET_EVENT: &str = "allow-indicator-reset";
const PAGE: &str = "allow-indicator.html";
/// Sidecar next to the data file. Not in `redd-block-data.json`: the
/// frontend owns that file's writes, and a second writer would race it.
const POSITION_FILE: &str = "allow-indicator-position.json";

const EDGE_MARGIN: f64 = 16.0;
const INITIAL_WIDTH: f64 = 260.0;
const INITIAL_HEIGHT: f64 = 36.0;
const MIN_WIDTH: f64 = 120.0;
const MAX_WIDTH: f64 = 420.0;
const MIN_HEIGHT: f64 = 28.0;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IndicatorSpace {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// What the indicator shows. `active == false` means no allow-mode space is
/// restricting anything right now and the window should be hidden.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndicatorState {
    pub active: bool,
    /// Running allow-mode spaces, earliest-started first.
    pub spaces: Vec<IndicatorSpace>,
    /// Effective allowed websites: union over allow spaces, minus anything a
    /// running block-mode space blocks. Meaningless when `all_websites`.
    pub websites: Vec<String>,
    /// No running allow space lists a website, so websites are not
    /// restricted by allow mode (`block_page::url_is_blocked`).
    pub all_websites: bool,
    pub apps: Vec<String>,
    /// Same rule for apps (`allowlist_active = !allowed.is_empty()`).
    pub all_apps: bool,
    /// A block-mode space is running too, so "all websites/apps" is not
    /// literally all of them.
    pub blocklist_also_active: bool,
    /// When the last running allow space ends; `None` if any is open-ended.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ends_at: Option<u64>,
}

/// Effective allowed sets from the active blocks. Pure, so the rule is
/// testable without a data file.
///
/// Mirrors enforcement rather than re-deciding it:
/// - websites: `block_page::url_is_blocked` (blocklist wins; subdomain match)
/// - apps: `native_host::derive_allowed_apps` and the watcher's blocked set
pub fn state_from_blocks(blocks: &[BlockInfo]) -> IndicatorState {
    let is_allow = |b: &&BlockInfo| native_host::blocklist_mode_is_allowlist(&b.mode);

    let mut allow: Vec<&BlockInfo> = blocks.iter().filter(is_allow).collect();
    // An allow space listing nothing restricts nothing; it is not a session
    // worth an indicator.
    allow.retain(|b| !b.domains.is_empty() || !b.apps.is_empty());
    if allow.is_empty() {
        return IndicatorState::default();
    }
    allow.sort_by_key(|b| b.started_at.unwrap_or(u64::MAX));

    let blocked: Vec<&BlockInfo> = blocks.iter().filter(|b| !is_allow(b)).collect();
    let blocked_domains: Vec<&String> = blocked.iter().flat_map(|b| b.domains.iter()).collect();
    let blocked_apps: Vec<&String> = blocked.iter().flat_map(|b| b.apps.iter()).collect();

    let mut websites: std::collections::BTreeSet<String> = Default::default();
    let mut apps: std::collections::BTreeSet<String> = Default::default();
    for b in &allow {
        websites.extend(b.domains.iter().cloned());
        apps.extend(b.apps.iter().cloned());
    }
    let all_websites = websites.is_empty();
    let all_apps = apps.is_empty();
    // Blocklist wins on overlap. An allowed domain is dropped when a blocked
    // domain covers it (same host or a parent), which is exactly when every
    // URL on it is blocked.
    websites.retain(|d| {
        !blocked_domains
            .iter()
            .any(|blocked| crate::block_page::domain_matches(d, blocked))
    });
    apps.retain(|a| !blocked_apps.iter().any(|b| b.eq_ignore_ascii_case(a)));

    let mut spaces: Vec<IndicatorSpace> = Vec::new();
    for b in &allow {
        let space = IndicatorSpace {
            name: b.name.clone().unwrap_or_default(),
            emoji: b.emoji.clone(),
            color: b.color.clone(),
        };
        // One space can run from a schedule and a manual start at once.
        if !spaces.contains(&space) {
            spaces.push(space);
        }
    }

    let ends_at = allow
        .iter()
        .map(|b| b.ends_at)
        .collect::<Option<Vec<u64>>>()
        .and_then(|ends| ends.into_iter().max());

    IndicatorState {
        active: true,
        spaces,
        websites: websites.into_iter().collect(),
        all_websites,
        apps: apps.into_iter().collect(),
        all_apps,
        blocklist_also_active: !blocked.is_empty(),
        ends_at,
    }
}

/// The settings the indicator reads from the data file.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct IndicatorSettings {
    eula_accepted: bool,
    enabled: bool,
    language: Option<String>,
    theme_mode: Option<String>,
}

fn settings_from_data(data: &serde_json::Value) -> IndicatorSettings {
    let settings = data.get("settings");
    let get = |key: &str| settings.and_then(|s| s.get(key));
    let text = |key: &str| get(key).and_then(|v| v.as_str()).map(String::from);
    IndicatorSettings {
        // Same test as `cross_app_consent`: nothing of ours appears on
        // screen before the EULA is accepted.
        eula_accepted: get("eulaAcceptedRevision")
            .and_then(|v| v.as_i64())
            .map(|n| n > 0)
            .unwrap_or(false)
            || get("eulaAccepted").and_then(|v| v.as_bool()) == Some(true),
        // Default on: only an explicit `false` turns it off.
        enabled: get("showAllowIndicator").and_then(|v| v.as_bool()) != Some(false),
        language: text("language"),
        theme_mode: text("themeMode"),
    }
}

/// What the page receives: the list plus how to dress it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndicatorPayload {
    #[serde(flatten)]
    pub state: IndicatorState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme_mode: Option<String>,
}

#[derive(Default)]
struct Runtime {
    /// The user closed the indicator for the current allow session. Cleared
    /// when no allow space is running, so the next session shows it again.
    dismissed: bool,
    last_payload: Option<IndicatorPayload>,
    window_wanted: bool,
    /// Bottom-right corner of the window, logical px. The window grows up
    /// and to the left from here, so it stays tucked in its corner.
    anchor: Option<(f64, f64)>,
    anchor_dirty: bool,
    size: (f64, f64),
}

fn runtime() -> &'static Mutex<Runtime> {
    static RUNTIME: OnceLock<Mutex<Runtime>> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        Mutex::new(Runtime {
            size: (INITIAL_WIDTH, INITIAL_HEIGHT),
            ..Default::default()
        })
    })
}

fn lock_runtime() -> std::sync::MutexGuard<'static, Runtime> {
    runtime().lock().unwrap_or_else(|e| e.into_inner())
}

/// Whether the window should be on screen, and what it should say.
fn decide(
    state: IndicatorState,
    settings: IndicatorSettings,
    dismissed: bool,
) -> (bool, IndicatorPayload) {
    let show = state.active && settings.enabled && settings.eula_accepted && !dismissed;
    (
        show,
        IndicatorPayload {
            state,
            language: settings.language,
            theme_mode: settings.theme_mode,
        },
    )
}

/// The file the indicator reads: the canonical data file.
///
/// A system-test build may point the indicator alone at a fixture, so the
/// window can be exercised on a developer's machine while the instance's
/// real data file stays empty and enforces nothing. Feature-gated like the
/// data-path override in `commands/data.rs`: a shipped build never reads it.
fn indicator_data_path() -> std::path::PathBuf {
    #[cfg(feature = "system-test")]
    if let Some(path) = system_test_fixture_path() {
        return path;
    }
    crate::commands::canonical_data_path_static()
}

#[cfg(feature = "e2e-webdriver")]
fn system_test_fixture_path() -> Option<std::path::PathBuf> {
    std::env::var_os("REDD_BLOCK_SYSTEM_TEST_ALLOW_INDICATOR_DATA_PATH")
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
}

fn read_current() -> (IndicatorState, IndicatorSettings) {
    let path = indicator_data_path();
    let settings = crate::data_cache::read(&path)
        .map(|data| settings_from_data(&data))
        .unwrap_or_default();
    let (_, blocks) = native_host::derive_payload(&path);
    (state_from_blocks(&blocks), settings)
}

fn position_file() -> Option<std::path::PathBuf> {
    indicator_data_path()
        .parent()
        .map(|dir| dir.join(POSITION_FILE))
}

fn load_saved_anchor() -> Option<(f64, f64)> {
    let raw = std::fs::read_to_string(position_file()?).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let x = json.get("right")?.as_f64()?;
    let y = json.get("bottom")?.as_f64()?;
    (x.is_finite() && y.is_finite()).then_some((x, y))
}

fn save_anchor(anchor: (f64, f64)) {
    let Some(path) = position_file() else { return };
    let body = serde_json::json!({ "right": anchor.0, "bottom": anchor.1 }).to_string();
    if let Err(e) = std::fs::write(&path, body) {
        log::debug!("allow_indicator: could not save position: {e}");
    }
}

/// Logical work-area rectangles `(x, y, w, h)` of every monitor.
fn monitor_areas(app: &AppHandle) -> Vec<(f64, f64, f64, f64)> {
    let Some(main_or_any) = app
        .get_webview_window(WINDOW_LABEL)
        .or_else(|| app.get_webview_window("main"))
    else {
        return Vec::new();
    };
    main_or_any
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let scale = m.scale_factor();
            let area = m.work_area();
            let pos = area.position.to_logical::<f64>(scale);
            let size = area.size.to_logical::<f64>(scale);
            (pos.x, pos.y, size.width, size.height)
        })
        .collect()
}

/// The saved corner if it is still on a connected screen, else the
/// bottom-right of the first screen. A corner saved on a monitor that has
/// since been unplugged would put the window where nobody can see it.
fn resolve_anchor(saved: Option<(f64, f64)>, areas: &[(f64, f64, f64, f64)]) -> (f64, f64) {
    let on_screen = |(x, y): (f64, f64)| {
        areas.iter().any(|&(ax, ay, aw, ah)| {
            x > ax + MIN_WIDTH && x <= ax + aw && y > ay + MIN_HEIGHT && y <= ay + ah
        })
    };
    if let Some(anchor) = saved.filter(|a| on_screen(*a)) {
        return anchor;
    }
    match areas.first() {
        Some(&(ax, ay, aw, ah)) => (ax + aw - EDGE_MARGIN, ay + ah - EDGE_MARGIN),
        None => (1200.0, 760.0),
    }
}

fn top_left_for(anchor: (f64, f64), size: (f64, f64)) -> (f64, f64) {
    (anchor.0 - size.0, anchor.1 - size.1)
}

fn place_window(window: &tauri::WebviewWindow, anchor: (f64, f64), size: (f64, f64)) {
    let (x, y) = top_left_for(anchor, size);
    let _ = window.set_size(tauri::LogicalSize::new(size.0, size.1));
    let _ = window.set_position(tauri::LogicalPosition::new(x, y));
}

#[cfg(target_os = "macos")]
tauri_nspanel::tauri_panel! {
    panel!(AllowIndicatorPanel {
        config: {
            can_become_key_window: false,
            can_become_main_window: false,
            becomes_key_only_if_needed: true,
            hides_on_deactivate: false,
            works_when_modal: true,
            is_floating_panel: true
        }
    })
}

/// Build the window hidden-in-place at its corner. macOS: main thread only
/// (AppKit). Windows: never the main thread inside a command (WebView2
/// deadlocks there, see the planner's focus.rs); the refresh thread is fine.
fn build_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(WINDOW_LABEL).is_some() {
        return Ok(());
    }
    let areas = monitor_areas(app);
    let (anchor, size) = {
        let mut rt = lock_runtime();
        let anchor = resolve_anchor(rt.anchor.or_else(load_saved_anchor), &areas);
        rt.anchor = Some(anchor);
        (anchor, rt.size)
    };
    let (x, y) = top_left_for(anchor, size);
    let url = tauri::WebviewUrl::App(PAGE.into());

    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::{CollectionBehavior, PanelBuilder, PanelLevel, StyleMask};
        let panel = PanelBuilder::<_, AllowIndicatorPanel>::new(app, WINDOW_LABEL)
            .url(url)
            .level(PanelLevel::Floating)
            .floating(true)
            .hides_on_deactivate(false)
            .collection_behavior(
                CollectionBehavior::new()
                    .can_join_all_spaces()
                    .stationary()
                    .full_screen_auxiliary()
                    .ignores_cycle(),
            )
            .style_mask(StyleMask::empty().nonactivating_panel())
            // The window is the card: clear behind, content clipped to the
            // radius, and the system shadow follows the rounded shape. This
            // needs no `macOSPrivateApi` because the webview itself stays
            // opaque.
            .corner_radius(12.0)
            .transparent(true)
            .has_shadow(true)
            .with_window(move |w| {
                w.title("")
                    .decorations(false)
                    .resizable(false)
                    .focused(false)
                    // Never key, so the first click must reach the page.
                    .accept_first_mouse(true)
                    .inner_size(size.0, size.1)
                    .position(x, y)
            })
            .build()
            .map_err(|e| e.to_string())?;
        panel.order_front_regardless();
    }

    #[cfg(not(target_os = "macos"))]
    {
        tauri::WebviewWindowBuilder::new(app, WINDOW_LABEL, url)
            .title("")
            .decorations(false)
            // Windows 11 rounds an undecorated window that keeps its shadow.
            .shadow(true)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible_on_all_workspaces(true)
            .focused(false)
            .zoom_hotkeys_enabled(false)
            .inner_size(size.0, size.1)
            .position(x, y)
            .build()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn show_window(app: &AppHandle) {
    if let Err(e) = build_window(app) {
        log::warn!("allow_indicator: could not build window: {e}");
        return;
    }
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt as _;
        if let Ok(panel) = app.get_webview_panel(WINDOW_LABEL) {
            if !panel.is_visible() {
                panel.order_front_regardless();
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        if !window.is_visible().unwrap_or(false) {
            let _ = window.show();
        }
    }
}

fn hide_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt as _;
        if let Ok(panel) = app.get_webview_panel(WINDOW_LABEL) {
            panel.hide();
        }
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.hide();
    }
}

fn apply_visibility(app: &AppHandle, show: bool) {
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if show {
                show_window(&handle);
            } else {
                hide_window(&handle);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    if show {
        show_window(app);
    } else {
        hide_window(app);
    }
}

/// Re-derive, then show, hide or update the window to match.
pub fn refresh(app: &AppHandle) {
    let (state, settings) = read_current();
    let (show, payload, changed, visibility_changed, anchor_to_save) = {
        let mut rt = lock_runtime();
        if !state.active {
            rt.dismissed = false;
        }
        let (show, payload) = decide(state, settings, rt.dismissed);
        let changed = rt.last_payload.as_ref() != Some(&payload);
        if changed {
            rt.last_payload = Some(payload.clone());
        }
        let visibility_changed = rt.window_wanted != show;
        rt.window_wanted = show;
        let anchor_to_save = (rt.anchor_dirty)
            .then(|| {
                rt.anchor_dirty = false;
                rt.anchor
            })
            .flatten();
        (show, payload, changed, visibility_changed, anchor_to_save)
    };
    if let Some(anchor) = anchor_to_save {
        save_anchor(anchor);
    }
    if visibility_changed {
        apply_visibility(app, show);
        if !show {
            let _ = app.emit_to(WINDOW_LABEL, RESET_EVENT, ());
        }
    }
    if show && (changed || visibility_changed) {
        let _ = app.emit_to(WINDOW_LABEL, STATE_EVENT, &payload);
    }
}

/// Start the refresh loop. One second matches the Automation watcher's tick,
/// so the list changes in step with what the browser starts blocking.
pub fn register(app: &tauri::App) {
    // The embedded WebDriver server addresses windows by handle; a second
    // window appearing mid-suite would make Tier 2 depend on which one it
    // happened to attach to. Test builds therefore run the indicator only
    // when a run asks for it by naming a fixture.
    #[cfg(feature = "e2e-webdriver")]
    if system_test_fixture_path().is_none() {
        return;
    }
    let handle = app.handle().clone();
    std::thread::spawn(move || loop {
        refresh(&handle);
        std::thread::sleep(std::time::Duration::from_secs(1));
    });
}

/// The page asks for its first paint; later changes arrive as events.
#[tauri::command]
pub fn allow_indicator_state() -> IndicatorPayload {
    let (state, settings) = read_current();
    decide(state, settings, false).1
}

/// Hide the indicator until the current allow session ends. Blocking is
/// untouched: this only flips a flag the refresh loop reads.
#[tauri::command]
pub fn allow_indicator_dismiss(app: AppHandle) {
    {
        let mut rt = lock_runtime();
        rt.dismissed = true;
        rt.window_wanted = false;
    }
    apply_visibility(&app, false);
    let _ = app.emit_to(WINDOW_LABEL, RESET_EVENT, ());
}

/// The page measured its content; resize around the bottom-right corner.
#[tauri::command]
pub fn allow_indicator_set_size(app: AppHandle, width: f64, height: f64) {
    if !width.is_finite() || !height.is_finite() {
        return;
    }
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    let max_height = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| {
            m.work_area()
                .size
                .to_logical::<f64>(m.scale_factor())
                .height
                * 0.8
        })
        .unwrap_or(600.0)
        .max(MIN_HEIGHT);
    let size = (
        width.clamp(MIN_WIDTH, MAX_WIDTH),
        height.clamp(MIN_HEIGHT, max_height),
    );
    let anchor = {
        let mut rt = lock_runtime();
        rt.size = size;
        rt.anchor
    };
    let Some(anchor) = anchor else { return };
    #[cfg(target_os = "macos")]
    {
        let _ = app.run_on_main_thread(move || place_window(&window, anchor, size));
    }
    #[cfg(not(target_os = "macos"))]
    place_window(&window, anchor, size);
}

/// The user is dragging the bar: move the window by the pointer's delta.
///
/// Done here rather than with the webview's `startDragging`, which wants the
/// mouse-down event still current and a window that can take focus; this
/// panel deliberately never does. A corner dragged off every screen is
/// ignored, so the window cannot be lost.
#[tauri::command]
pub fn allow_indicator_move_by(app: AppHandle, dx: f64, dy: f64) {
    if !dx.is_finite() || !dy.is_finite() {
        return;
    }
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    let areas = monitor_areas(&app);
    let (anchor, size) = {
        let mut rt = lock_runtime();
        let Some(current) = rt.anchor else { return };
        let wanted = (current.0 + dx, current.1 + dy);
        if resolve_anchor(Some(wanted), &areas) != wanted {
            return;
        }
        rt.anchor = Some(wanted);
        rt.anchor_dirty = true;
        (wanted, rt.size)
    };
    #[cfg(target_os = "macos")]
    {
        let _ = app.run_on_main_thread(move || place_window(&window, anchor, size));
    }
    #[cfg(not(target_os = "macos"))]
    place_window(&window, anchor, size);
}

#[cfg(test)]
mod tests;
