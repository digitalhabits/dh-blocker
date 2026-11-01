//! Shared parse cache for the canonical data file.
//!
//! Native website and app watchers derive policy on their own ticks.
//! Share the parsed file to avoid repeated disk reads while keeping all
//! time-dependent decisions live.
//!
//! This module caches the *parsed* `serde_json::Value` keyed on the
//! file's (mtime, len). Derivations stay live — they depend on `now()`
//! — but the parse only happens when the file actually changed. The
//! file is only ever replaced via atomic rename
//! (`write_data_file_atomic`), which always produces a fresh mtime, so
//! the (mtime, len) key is a reliable change signal even for writes
//! from other processes. Same-process
//! writers additionally call [`invalidate`] so a rewrite within the
//! filesystem's timestamp granularity can't serve a stale snapshot.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

struct Entry {
    mtime: SystemTime,
    len: u64,
    value: Arc<serde_json::Value>,
}

static CACHE: OnceLock<Mutex<HashMap<PathBuf, Entry>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<PathBuf, Entry>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Parsed snapshot of the JSON file at `path`, re-read only when the
/// file's (mtime, len) changed since the last call. Returns `None` when
/// the file is missing, unreadable, or not valid JSON — the same cases
/// where callers previously bailed to their empty defaults.
pub fn read(path: &Path) -> Option<Arc<serde_json::Value>> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta.modified().ok()?;
    let len = meta.len();

    if let Ok(guard) = cache().lock() {
        if let Some(e) = guard.get(path) {
            if e.mtime == mtime && e.len == len {
                return Some(e.value.clone());
            }
        }
    }

    let raw = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let value = Arc::new(value);
    if let Ok(mut guard) = cache().lock() {
        guard.insert(
            path.to_path_buf(),
            Entry {
                mtime,
                len,
                value: value.clone(),
            },
        );
    }
    Some(value)
}

/// Drop the cached snapshot for `path`. Called after every same-process
/// write so the next read re-parses even if the rewrite landed within
/// the filesystem's timestamp granularity.
pub fn invalidate(path: &Path) {
    if let Ok(mut guard) = cache().lock() {
        guard.remove(path);
    }
}

#[cfg(test)]
mod tests;
