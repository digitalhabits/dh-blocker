//! Effective desktop policy, independent of browser transport.
use serde::Serialize;
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

/// Metadata for one effective website policy segment and its block page.
#[derive(Debug, Clone, Serialize)]
pub struct BlockInfo {
    #[serde(rename = "blocklistId")]
    pub blocklist_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// `"blocklist"` (default) or `"allowlist"`. In allowlist mode `domains`
    /// lists sites the user *may* visit; everything else is blocked.
    pub mode: String,
    pub domains: Vec<String>,
    /// Apps from the blocklist for this active segment (blocked or allowed
    /// depending on `mode`). Omitted from diagnostics when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub apps: Vec<String>,
    pub source: &'static str, // "schedule" | "activeBlock"
    #[serde(rename = "endsAt", skip_serializing_if = "Option::is_none")]
    pub ends_at: Option<u64>,
    #[serde(rename = "startedAt", skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
}

pub fn blocklist_mode_is_allowlist(mode: &str) -> bool {
    mode.eq_ignore_ascii_case("allowlist")
}

/// `(name, emoji, color, mode, websites_lowercased, apps)` for one blocklist.
type BlocklistMeta = (
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    Vec<String>,
    Vec<String>,
);

/// Derive effective domains and policy segments from persisted user rules.
pub fn derive_payload(data_path: &std::path::Path) -> (Vec<String>, Vec<BlockInfo>) {
    // mtime-keyed parse cache: this runs on every native watcher tick,
    // but the file only changes on user actions. The derivation below
    // stays live (it depends on now()); only the parse is cached.
    let data = match crate::data_cache::read(data_path) {
        Some(d) => d,
        None => return (vec![], vec![]),
    };
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let blocklists = data
        .get("blocklists")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let active = data
        .get("activeBlocks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let schedules = data
        .get("schedules")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let blocklist_meta = |id: &str| -> Option<BlocklistMeta> {
        blocklists
            .iter()
            .find(|b| b.get("id").and_then(|v| v.as_str()) == Some(id))
            .map(|b| {
                let name = b.get("name").and_then(|v| v.as_str()).map(String::from);
                let emoji = b.get("emoji").and_then(|v| v.as_str()).map(String::from);
                let color = b.get("color").and_then(|v| v.as_str()).map(String::from);
                let mode = b
                    .get("mode")
                    .and_then(|v| v.as_str())
                    .unwrap_or("blocklist")
                    .to_string();
                let websites: Vec<String> = b
                    .get("websites")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(normalize_website_entry))
                            .collect()
                    })
                    .unwrap_or_default();
                let apps: Vec<String> = b
                    .get("apps")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .filter(|n| !crate::app_watcher::is_protected_app_name(n))
                            .collect()
                    })
                    .unwrap_or_default();
                (name, emoji, color, mode, websites, apps)
            })
    };

    let mut domains: std::collections::BTreeSet<String> = Default::default();
    let mut blocks: Vec<BlockInfo> = Vec::new();

    for ab in &active {
        let start = ab.get("startTime").and_then(|v| v.as_u64()).unwrap_or(0);
        let end = ab.get("endTime").and_then(|v| v.as_u64()).unwrap_or(0);
        if one_off_pause_active(ab, now_ms) || now_ms < start || now_ms >= end {
            continue;
        }
        let id = match ab.get("blocklistId").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => continue,
        };
        if let Some((name, emoji, color, mode, websites, apps)) = blocklist_meta(id) {
            // The flat blocked-domain union contains only
            // blocklist-mode domains belong here. Allowlist enforcement reads
            // `blocks[].mode` + `blocks[].domains` instead.
            if !blocklist_mode_is_allowlist(&mode) {
                for w in &websites {
                    domains.insert(w.clone());
                }
            }
            blocks.push(BlockInfo {
                blocklist_id: id.to_string(),
                name,
                emoji,
                color,
                mode,
                domains: websites,
                apps,
                source: "activeBlock",
                ends_at: Some(end),
                started_at: Some(start),
            });
        }
    }

    for sch in &schedules {
        let m = match match_schedule_now(sch, now_ms) {
            Some(m) => m,
            None => continue,
        };
        let id = match sch.get("blocklistId").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => continue,
        };
        if let Some((name, emoji, color, mode, websites, apps)) = blocklist_meta(id) {
            if !blocklist_mode_is_allowlist(&mode) {
                for w in &websites {
                    domains.insert(w.clone());
                }
            }
            blocks.push(BlockInfo {
                blocklist_id: id.to_string(),
                name,
                emoji,
                color,
                mode,
                domains: websites,
                apps,
                source: "schedule",
                ends_at: m.ends_at,
                started_at: m.started_at,
            });
        }
    }

    blocks.sort_by_key(|b| b.ends_at.unwrap_or(u64::MAX));
    (domains.into_iter().collect(), blocks)
}

/// Backward-compatible wrapper that returns just the flat domain list.
pub fn derive_blocklist(data_path: &std::path::Path) -> Vec<String> {
    derive_payload(data_path).0
}

/// Effective blocked-app set at `now()`, mirroring the frontend's
/// `updateBlockedApps` merge of active one-offs and live schedule
/// segments. App-only schedules (no websites) still contribute here
/// even though `derive_payload` only surfaces domains.
pub fn derive_blocked_apps(data_path: &std::path::Path) -> Vec<String> {
    let data = match crate::data_cache::read(data_path) {
        Some(d) => d,
        None => return vec![],
    };
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let blocklists = data
        .get("blocklists")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let active = data
        .get("activeBlocks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let schedules = data
        .get("schedules")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let blocklist_apps = |id: &str| -> Option<(String, Vec<String>)> {
        blocklists
            .iter()
            .find(|b| b.get("id").and_then(|v| v.as_str()) == Some(id))
            .map(|b| {
                let mode = b
                    .get("mode")
                    .and_then(|v| v.as_str())
                    .unwrap_or("blocklist")
                    .to_string();
                let apps: Vec<String> = b
                    .get("apps")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                (mode, apps)
            })
    };

    let mut apps: std::collections::BTreeSet<String> = Default::default();

    for ab in &active {
        let start = ab.get("startTime").and_then(|v| v.as_u64()).unwrap_or(0);
        let end = ab.get("endTime").and_then(|v| v.as_u64()).unwrap_or(0);
        if one_off_pause_active(ab, now_ms) || now_ms < start || now_ms >= end {
            continue;
        }
        let Some(id) = ab.get("blocklistId").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some((mode, block_apps)) = blocklist_apps(id) else {
            continue;
        };
        if blocklist_mode_is_allowlist(&mode) {
            continue;
        }
        for app in block_apps {
            if !crate::app_watcher::is_protected_app_name(&app) {
                apps.insert(app);
            }
        }
    }

    for sch in &schedules {
        if match_schedule_now(sch, now_ms).is_none() {
            continue;
        }
        let Some(id) = sch.get("blocklistId").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some((mode, block_apps)) = blocklist_apps(id) else {
            continue;
        };
        if blocklist_mode_is_allowlist(&mode) {
            continue;
        }
        for app in block_apps {
            if !crate::app_watcher::is_protected_app_name(&app) {
                apps.insert(app);
            }
        }
    }

    apps.into_iter().collect()
}

/// Effective allowed-app set for allowlist-mode blocks at `now()`.
/// Mirrors the frontend's `collectAllowedApps` merge.
pub fn derive_allowed_apps(data_path: &std::path::Path) -> Vec<String> {
    let data = match crate::data_cache::read(data_path) {
        Some(d) => d,
        None => return vec![],
    };
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let blocklists = data
        .get("blocklists")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let active = data
        .get("activeBlocks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let schedules = data
        .get("schedules")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let blocklist_apps = |id: &str| -> Option<(String, Vec<String>)> {
        blocklists
            .iter()
            .find(|b| b.get("id").and_then(|v| v.as_str()) == Some(id))
            .map(|b| {
                let mode = b
                    .get("mode")
                    .and_then(|v| v.as_str())
                    .unwrap_or("blocklist")
                    .to_string();
                let apps: Vec<String> = b
                    .get("apps")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                (mode, apps)
            })
    };

    let mut apps: std::collections::BTreeSet<String> = Default::default();

    for ab in &active {
        let start = ab.get("startTime").and_then(|v| v.as_u64()).unwrap_or(0);
        let end = ab.get("endTime").and_then(|v| v.as_u64()).unwrap_or(0);
        if one_off_pause_active(ab, now_ms) || now_ms < start || now_ms >= end {
            continue;
        }
        let Some(id) = ab.get("blocklistId").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some((mode, block_apps)) = blocklist_apps(id) else {
            continue;
        };
        if !blocklist_mode_is_allowlist(&mode) {
            continue;
        }
        for app in block_apps {
            if !crate::app_watcher::is_protected_app_name(&app) {
                apps.insert(app);
            }
        }
    }

    for sch in &schedules {
        if match_schedule_now(sch, now_ms).is_none() {
            continue;
        }
        let Some(id) = sch.get("blocklistId").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some((mode, block_apps)) = blocklist_apps(id) else {
            continue;
        };
        if !blocklist_mode_is_allowlist(&mode) {
            continue;
        }
        for app in block_apps {
            if !crate::app_watcher::is_protected_app_name(&app) {
                apps.insert(app);
            }
        }
    }

    apps.into_iter().collect()
}

#[derive(Debug, Clone, Copy)]
struct ScheduleMatch {
    started_at: Option<u64>,
    ends_at: Option<u64>,
}

/// Whether a one-off block's pause still suppresses enforcement at `now_ms`.
///
/// Mirrors the schedule rule in `match_schedule_now`: a pause holds only until
/// `pauseEndTime`. Derivation must not wait for the frontend to clear
/// `isPaused` — that sweep is a 1 s JS interval in `src/render.js`, and macOS
/// throttles WKWebView timers while the window is hidden, which is the app's
/// normal tray state. Keying off the flag alone left a block silently
/// unenforced past its pause end.
///
/// A missing `pauseEndTime` reads as "not paused" for one-off blocks. The
/// app never writes that shape for a block (switching a Manual space off
/// deletes its block, and timed pauses always carry an end time), so it can
/// only come from a hand-edited data file — and then it fails safe, towards
/// blocking. Schedules are the deliberate exception: see `match_schedule_now`.
pub(crate) fn one_off_pause_active(active_block: &Value, now_ms: u64) -> bool {
    let paused = active_block
        .get("isPaused")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !paused {
        return false;
    }
    let pause_end = active_block
        .get("pauseEndTime")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    pause_end > now_ms
}

/// If any segment of `schedule` is active at `now_ms`, return the
/// absolute start/end epoch-ms of that segment occurrence. Mirrors the
/// frontend `isScheduleSegmentActiveNow` semantics including
/// cross-midnight, all-day, and pause-aware rules.
fn match_schedule_now(schedule: &Value, now_ms: u64) -> Option<ScheduleMatch> {
    let paused = schedule
        .get("isPaused")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    // `isPaused` with no `pauseEndTime` is a schedule the user switched OFF
    // (the card switch writes exactly this after the override challenge). The
    // frontend engine, Android and iOS all read it as "paused until turned on
    // again", and desktop must agree or a switched-off space would keep
    // blocking on macOS/Windows only.
    if paused {
        match schedule.get("pauseEndTime").and_then(|v| v.as_u64()) {
            Some(end) if end <= now_ms => {} // timed pause already over
            _ => return None,                // still paused, or switched off
        }
    }
    let segments = schedule
        .get("resolvedSegments")
        .and_then(|v| v.as_array())
        .or_else(|| schedule.get("segments").and_then(|v| v.as_array()))?;
    let (wd, hour, minute, sec) = local_time_components_full(now_ms)?;
    let now_min = hour as u32 * 60 + minute as u32;

    // Today's local-midnight as epoch ms. Computed by subtracting the
    // local time-of-day offset from now_ms — works across DST jumps as
    // long as the local-time components themselves are correct.
    let today_offset_secs = (hour as u64) * 3600 + (minute as u64) * 60 + (sec as u64);
    let now_secs = now_ms / 1000;
    let midnight_today_ms = now_secs.saturating_sub(today_offset_secs) * 1000;
    let yesterday_midnight_ms = midnight_today_ms.saturating_sub(86_400_000);

    for seg in segments {
        if let (Some(active_from), Some(active_until)) = (
            seg.get("activeFromTimestampMs").and_then(|v| v.as_u64()),
            seg.get("activeUntilTimestampMs").and_then(|v| v.as_u64()),
        ) {
            if now_ms >= active_from && now_ms < active_until {
                return Some(ScheduleMatch {
                    started_at: Some(active_from),
                    ends_at: Some(active_until),
                });
            }
            continue;
        }

        let sh = seg.get("startHour").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let sm = seg.get("startMinute").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let eh = seg.get("endHour").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let em = seg.get("endMinute").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let start_min = sh * 60 + sm;
        let end_min = eh * 60 + em;
        let days: Vec<u8> = seg
            .get("days")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_u64().map(|x| x as u8))
                    .collect()
            })
            .unwrap_or_default();

        let all_day = start_min == end_min;
        if all_day {
            if days.contains(&wd) {
                return Some(ScheduleMatch {
                    started_at: Some(midnight_today_ms),
                    ends_at: Some(midnight_today_ms + 86_400_000),
                });
            }
            continue;
        }

        if start_min < end_min {
            if days.contains(&wd) && now_min >= start_min && now_min < end_min {
                return Some(ScheduleMatch {
                    started_at: Some(midnight_today_ms + start_min as u64 * 60_000),
                    ends_at: Some(midnight_today_ms + end_min as u64 * 60_000),
                });
            }
        } else {
            // Cross-midnight.
            let yesterday = (wd + 6) % 7;
            if days.contains(&wd) && now_min >= start_min {
                return Some(ScheduleMatch {
                    started_at: Some(midnight_today_ms + start_min as u64 * 60_000),
                    ends_at: Some(midnight_today_ms + 86_400_000 + end_min as u64 * 60_000),
                });
            }
            if days.contains(&yesterday) && now_min < end_min {
                return Some(ScheduleMatch {
                    started_at: Some(yesterday_midnight_ms + start_min as u64 * 60_000),
                    ends_at: Some(midnight_today_ms + end_min as u64 * 60_000),
                });
            }
        }
    }
    None
}

/// Return (weekday 0=Mon..6=Sun, hour 0..23, minute 0..59, second 0..59)
/// in the system local timezone. Uses libc `localtime_r` on unix and
/// `GetLocalTime` on Windows.
///
/// NOTE on weekday encoding: schedule `days` arrays in
/// `redd-block-data.json` are authored by `src/app.js` using the
/// JS Mon=0..Sun=6 convention (see
/// `isScheduleSegmentActiveNow`'s `currentDay` mapping). Both
/// `tm_wday` and Win32 `SYSTEMTIME.wDayOfWeek` are Sun=0..Sat=6, so
/// we shift here once at the source — *not* in `match_schedule_now`
/// — to keep the comparison sites identical to the JS predicate.
fn local_time_components_full(now_ms: u64) -> Option<(u8, u8, u8, u8)> {
    /// C-Sun=0..Sat=6 → JS-Mon=0..Sun=6.
    fn shift_weekday(c_wday: u8) -> u8 {
        if c_wday == 0 {
            6
        } else {
            c_wday - 1
        }
    }

    let secs = (now_ms / 1000) as i64;
    #[cfg(unix)]
    unsafe {
        let time: libc::time_t = secs as libc::time_t;
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&time, &mut tm).is_null() {
            return None;
        }
        Some((
            shift_weekday(tm.tm_wday as u8),
            tm.tm_hour as u8,
            tm.tm_min as u8,
            tm.tm_sec as u8,
        ))
    }
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{FILETIME, SYSTEMTIME};
        use windows::Win32::System::Time::FileTimeToSystemTime;
        // Convert unix seconds to a FILETIME (100ns ticks since 1601-01-01).
        const EPOCH_DIFF_100NS: i64 = 116_444_736_000_000_000;
        let ticks = secs * 10_000_000 + EPOCH_DIFF_100NS;
        let ft = FILETIME {
            dwLowDateTime: (ticks as u32),
            dwHighDateTime: ((ticks >> 32) as u32),
        };
        let mut utc = SYSTEMTIME::default();
        let mut local = SYSTEMTIME::default();
        unsafe {
            if FileTimeToSystemTime(&ft, &mut utc).is_err() {
                return None;
            }
            if windows::Win32::System::Time::SystemTimeToTzSpecificLocalTime(None, &utc, &mut local)
                .is_err()
            {
                return None;
            }
        }
        Some((
            shift_weekday(local.wDayOfWeek as u8),
            local.wHour as u8,
            local.wMinute as u8,
            local.wSecond as u8,
        ))
    }
}

/// Canonical form of a stored website entry: lowercased, without a leading
/// `www.` label. Matching is "host == entry or a subdomain of entry", so an
/// entry kept as `www.example.com` would never match `example.com` and the
/// block would silently miss the bare domain. The input field strips `www.`
/// too (`cleanDomainInput` in `src/website-input.js`); this covers data saved
/// before it did, imports, and hand-edited files. Deliberately widens the
/// entry to the whole site — for a blocklist that errs toward blocking, which
/// is what someone typing `www.` meant. `www.com` itself is left alone.
fn normalize_website_entry(entry: &str) -> String {
    let lower = entry.trim().to_lowercase();
    match lower.strip_prefix("www.") {
        Some(rest) if rest.contains('.') => rest.to_string(),
        _ => lower,
    }
}

#[cfg(test)]
mod tests;
