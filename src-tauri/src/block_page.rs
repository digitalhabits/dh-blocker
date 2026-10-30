// Website-blocking decisions shared by the desktop watchers that drive a
// browser from outside: Apple Events on macOS (web_automation.rs) and UI
// Automation on Windows (uia_web_automation.rs). Given the URLs a browser
// is showing, decide which to send to the bundled block page and which
// parked tabs to restore. Ported from the extension's background.js so all
// three paths block the same URLs and show the same block page.
//
// Nothing here talks to a browser or the OS; the platform modules read tabs
// and apply the actions.

use tauri::{AppHandle, Manager};

use crate::native_host::{self, BlockInfo};

/// True when any active block enforces website restrictions (blocklist
/// domains or allowlist-only browsing).
pub fn web_enforcement_active(blocks: &[BlockInfo]) -> bool {
    // Both modes come down to the same question: an allowlist block with no
    // domains allows everything, and a blocklist block with no domains blocks
    // nothing. Matches `enforcer::website_blocking_active`.
    blocks.iter().any(|b| !b.domains.is_empty())
}

/// Decide what to do with each tab: redirect blocked sites to the block
/// page, restore block-page tabs whose original URL is no longer
/// blocked. Returns (window_index, tab_index, new_url) triples.
///
/// Restore matches the extension's `restoreUnblockedTabs`: any parked
/// tab whose original URL is no longer blocked is restored, even when
/// other website enforcement is still active.
pub(crate) fn plan_actions(
    tabs: &[Tab],
    blocks: &[BlockInfo],
    block_page_url: &str,
) -> Vec<(u32, u32, String)> {
    let mut actions = Vec::new();
    for tab in tabs {
        if is_block_page_url(&tab.url, block_page_url) {
            #[cfg(feature = "system-test")]
            if std::env::var_os("SYSTEM_TEST_RUNNER").is_some()
                && !block_page_owned_by_system_test(&tab.url)
            {
                // Shared-browser runs may coexist with the production app.
                // Never restore a parked tab that this test process did not
                // create; its active block belongs to another process/store.
                continue;
            }
            if let Some(original) = original_url_from_block_page(&tab.url) {
                if is_http_url(&original) && !url_is_blocked(&original, blocks) {
                    actions.push((tab.window_index, tab.tab_index, original));
                }
            }
            continue;
        }
        if !is_http_url(&tab.url) {
            continue;
        }
        if url_is_blocked(&tab.url, blocks) {
            let target = build_blocked_url(block_page_url, &tab.url, blocks);
            actions.push((tab.window_index, tab.tab_index, target));
        }
    }
    actions
}

/// One tab as a browser reports it. Indices are whatever the platform
/// layer addresses tabs by; this module only hands them back.
#[derive(Debug)]
pub(crate) struct Tab {
    pub(crate) window_index: u32,
    pub(crate) tab_index: u32,
    pub(crate) url: String,
}

// ---- Block-page URL + matching (ported from background.js) ----------------

/// True if the tab is already showing our block page. Primary check is
/// the resolved `file://` prefix; the path fallback guards against
/// browser-specific file-URL normalization that could otherwise cause
/// an infinite redirect loop.
pub(crate) fn is_block_page_url(url: &str, block_page_url: &str) -> bool {
    url.starts_with(block_page_url) || url.contains("blocked/blocked.html")
}

/// Pull the original site URL back out of a block-page URL's `u` param.
pub(crate) fn original_url_from_block_page(url: &str) -> Option<String> {
    let query = url.split('?').nth(1)?;
    for pair in query.split('&') {
        let mut kv = pair.splitn(2, '=');
        if kv.next() == Some("u") {
            return kv.next().map(pct_decode);
        }
    }
    None
}

#[cfg(feature = "system-test")]
pub(crate) fn block_page_owned_by_system_test(url: &str) -> bool {
    let Some(query) = url.split('?').nth(1) else {
        return false;
    };
    query.split('&').any(|pair| {
        let mut kv = pair.splitn(2, '=');
        kv.next() == Some("id")
            && kv
                .next()
                .map(pct_decode)
                .is_some_and(|id| id.starts_with("system-test-"))
    })
}

/// Build the block-page URL with as much block metadata as we have, so
/// the page shows the same pill / countdown / source the extension does.
/// Mirrors `buildBlockedUrl` in background.js.
pub(crate) fn build_blocked_url(
    block_page_url: &str,
    original_url: &str,
    blocks: &[BlockInfo],
) -> String {
    let mut query = format!("u={}", pct_encode(original_url));
    if let Some(info) = block_info_for_url(original_url, blocks) {
        query.push_str(&format!("&id={}", pct_encode(&info.blocklist_id)));
        query.push_str(&format!("&mode={}", pct_encode(&info.mode)));
        if let Some(name) = &info.name {
            query.push_str(&format!("&name={}", pct_encode(name)));
        }
        if let Some(emoji) = &info.emoji {
            query.push_str(&format!("&emoji={}", pct_encode(emoji)));
        }
        if let Some(color) = &info.color {
            query.push_str(&format!("&color={}", pct_encode(color)));
        }
        query.push_str(&format!("&source={}", pct_encode(info.source)));
        if let Some(ends_at) = info.ends_at {
            query.push_str(&format!("&endsAt={ends_at}"));
        }
        if let Some(started_at) = info.started_at {
            query.push_str(&format!("&startedAt={started_at}"));
        }
    }
    format!("{block_page_url}?{query}")
}

/// Metadata block to attribute a blocked URL to.
///
/// Mirrors desktop app composition: blocklist hits win for attribution, then
/// allowlist-mode blocks attribute to the earliest-started active allowlist
/// that excludes the host. For schedules this uses the current active segment's
/// start time from `derive_payload`, so "first in time" means first enforcement
/// start, not schedule creation order.
pub(crate) fn block_info_for_url<'a>(url: &str, blocks: &'a [BlockInfo]) -> Option<&'a BlockInfo> {
    let host = hostname_of(url)?;
    if !url_is_blocked(url, blocks) {
        return None;
    }

    // Blocklist hit takes precedence for metadata (same as app watcher).
    if let Some(b) = blocks.iter().find(|b| {
        !native_host::blocklist_mode_is_allowlist(&b.mode)
            && b.domains.iter().any(|d| domain_matches(&host, d))
    }) {
        return Some(b);
    }

    // Blocked by allowlist — attribute to the earliest-started active allowlist
    // that excludes the host. Tie-break by soonest-ending block so the choice
    // stays deterministic when two allowlists started together.
    blocks
        .iter()
        .filter(|b| native_host::blocklist_mode_is_allowlist(&b.mode) && !b.domains.is_empty())
        .filter(|b| !b.domains.iter().any(|d| domain_matches(&host, d)))
        .min_by_key(|b| {
            (
                b.started_at.unwrap_or(u64::MAX),
                b.ends_at.unwrap_or(u64::MAX),
            )
        })
}

const PROTECTED_HOSTS: &[&str] = &[
    "localhost",
    "localhost.localdomain",
    "127.0.0.1",
    "0.0.0.0",
    "::1",
    "broadcasthost",
    "local",
    "reddfocus.org",
    "www.reddfocus.org",
    "digitalhabits.org",
    "www.digitalhabits.org",
    "ulyngs.github.io",
    "digitalhabits.github.io",
];

fn is_protected_host(host: &str) -> bool {
    let lower = host.to_ascii_lowercase();
    PROTECTED_HOSTS
        .iter()
        .any(|p| lower == *p || lower.ends_with(&format!(".{p}")))
}

/// Whether a tab URL should redirect to the block page given active blocks.
///
/// Composition matches desktop app enforcement:
/// 1. Blocklist-mode domains always block (blocklist wins over allowlist).
/// 2. When any allowlist website block is active, the union of allowlisted
///    domains is allowed; everything else is blocked.
pub fn url_is_blocked(url: &str, blocks: &[BlockInfo]) -> bool {
    if !is_http_url(url) {
        return false;
    }
    let host = match hostname_of(url) {
        Some(h) => h,
        None => return false,
    };
    if is_protected_host(&host) {
        return false;
    }

    // Blocklist blocks: URL matches → blocked.
    for b in blocks
        .iter()
        .filter(|b| !native_host::blocklist_mode_is_allowlist(&b.mode))
    {
        if b.domains.iter().any(|d| domain_matches(&host, d)) {
            return true;
        }
    }

    // Allowlist blocks: any active allowlist with domains → block unless allowed.
    //
    // `domain_matches` covers subdomains, so allowing `example.com` also allows
    // `mail.example.com`. That is deliberate, and it is the one place allow mode
    // errs towards permitting: allowing a site without the subdomains it actually
    // serves from would be unusable, and the user named the domain themselves.
    // The same rule on the blocking side errs the other way, which is why one
    // matcher serves both — `old.reddit.com` must not walk past a blocked
    // `reddit.com`. Exact-host allows would be a behaviour change, not a fix.
    let allowlist_active = blocks
        .iter()
        .any(|b| native_host::blocklist_mode_is_allowlist(&b.mode) && !b.domains.is_empty());
    if allowlist_active {
        let allowed = blocks.iter().any(|b| {
            native_host::blocklist_mode_is_allowlist(&b.mode)
                && b.domains.iter().any(|d| domain_matches(&host, d))
        });
        if !allowed {
            return true;
        }
    }

    false
}

pub(crate) fn domain_matches(host: &str, domain: &str) -> bool {
    host == domain || host.ends_with(&format!(".{domain}"))
}

fn is_http_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// Lowercased hostname of an http(s) URL, sans userinfo/port. Small
/// hand-rolled parser so we don't pull in the `url` crate just for this.
pub(crate) fn hostname_of(url: &str) -> Option<String> {
    let after_scheme = url.split_once("://").map(|(_, rest)| rest)?;
    let authority_end = after_scheme
        .find(['/', '?', '#'])
        .unwrap_or(after_scheme.len());
    let authority = &after_scheme[..authority_end];
    let host_port = authority
        .rsplit_once('@')
        .map(|(_, h)| h)
        .unwrap_or(authority);
    let host = if let Some(rest) = host_port.strip_prefix('[') {
        // IPv6 literal: keep everything up to the closing bracket.
        rest.split_once(']').map(|(h, _)| h).unwrap_or(rest)
    } else {
        host_port.split(':').next().unwrap_or(host_port)
    };
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

/// Percent-encode a query-component value: keep unreserved chars
/// (RFC 3986 ALPHA / DIGIT / -._~), `%`-escape everything else byte-wise.
pub(crate) fn pct_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        let keep = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~');
        if keep {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(hex_digit(b >> 4));
            out.push(hex_digit(b & 0x0f));
        }
    }
    out
}

fn hex_digit(n: u8) -> char {
    match n {
        0..=9 => (b'0' + n) as char,
        _ => (b'A' + (n - 10)) as char,
    }
}

/// Inverse of `pct_encode` (also turns `+` into space, matching how
/// browsers treat query components).
pub(crate) fn pct_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = hex_val(bytes[i + 1]);
                let lo = hex_val(bytes[i + 2]);
                if let (Some(hi), Some(lo)) = (hi, lo) {
                    out.push((hi << 4) | lo);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Turn a filesystem path into a `file://` URL, percent-encoding each
/// segment (the app bundle path contains a space: "ReDD Blocker.app").
pub fn path_to_file_url(path: &std::path::Path) -> String {
    path_str_to_file_url(&path.to_string_lossy())
}

/// `path_to_file_url` on a string, so the Windows shape can be tested on
/// macOS too. Backslashes separate segments as well, and a leading drive
/// letter keeps its colon: `C:\Program Files\x` becomes
/// `file:///C:/Program%20Files/x`, which is what a browser expects.
pub(crate) fn path_str_to_file_url(path: &str) -> String {
    let mut url = String::from("file://");
    let mut first = true;
    for component in path.split(['/', '\\']) {
        if component.is_empty() {
            continue;
        }
        url.push('/');
        if first && is_drive_letter(component) {
            url.push_str(component);
        } else {
            url.push_str(&pct_encode_path_segment(component));
        }
        first = false;
    }
    url
}

fn is_drive_letter(segment: &str) -> bool {
    let b = segment.as_bytes();
    b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// Like `pct_encode` but also preserves a handful of path-safe sub-delims
/// so the URL stays readable; the spaces in "Digital Habits Blocker" become %20.
fn pct_encode_path_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        let keep = b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'-' | b'_'
                    | b'.'
                    | b'~'
                    | b'!'
                    | b'$'
                    | b'&'
                    | b'('
                    | b')'
                    | b'+'
                    | b','
                    | b'='
                    | b'@'
            );
        if keep {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(hex_digit(b >> 4));
            out.push(hex_digit(b & 0x0f));
        }
    }
    out
}

/// Resolve the bundled block page to a `file://` base URL (no query
/// string). Packaged builds stage it at `<resources>/blocked/blocked.html`
/// (`bundle.resources` in tauri.conf.json). In `tauri dev` / `pnpm dev`,
/// `resource_dir()` often fails with "unknown path", so we fall back to the
/// `src-tauri/blocked/` sources next to this crate.
pub fn resolve_block_page_url(app: &AppHandle) -> Option<String> {
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|e| {
            log::warn!("block_page: cannot resolve resource dir: {e}");
            e
        })
        .ok()
        .map(|d| d.join("blocked").join("blocked.html"));

    if let Some(ref page) = bundled {
        if page.is_file() {
            return Some(path_to_file_url(page));
        }
    }

    let dev_page = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("blocked")
        .join("blocked.html");
    if dev_page.is_file() {
        log::info!("block_page: using dev block page at {}", dev_page.display());
        return Some(path_to_file_url(&dev_page));
    }

    if let Some(page) = bundled {
        log::warn!(
            "block_page: bundled block page not found at {} — redirects will 404",
            page.display()
        );
        return Some(path_to_file_url(&page));
    }

    log::warn!(
        "block_page: no block page URL (resource dir missing and no src-tauri/blocked fallback)"
    );
    None
}

// ---- Address-bar text (Windows UI Automation) ------------------------------

/// Characters a browser may put in its address bar that are not part of the
/// URL: bidi marks, zero-width spaces, a BOM. Samsung Internet's invisible
/// U+200E prefix silently disabled Android blocking until it was stripped;
/// the same class of bug is possible here, so strip them up front.
#[cfg(any(target_os = "windows", test))]
const INVISIBLE_PREFIXES: &[char] = &[
    '\u{200B}', '\u{200C}', '\u{200D}', '\u{200E}', '\u{200F}', '\u{202A}', '\u{202B}', '\u{202C}',
    '\u{202D}', '\u{202E}', '\u{2066}', '\u{2067}', '\u{2068}', '\u{2069}', '\u{FEFF}',
];

/// Turn what a Chromium address bar displays into a URL we can match.
///
/// Chromium elides the scheme (and `www.`) for display, so `reddit.com/r/x`
/// stands for `https://reddit.com/r/x`; the `www.` loss is harmless because
/// stored domains have it stripped too. Text with a scheme is returned as
/// is, so the block page's `file://` URL still reaches `plan_actions`.
///
/// Failures fall towards allowing: `None` for anything that does not look
/// like a URL (a half-typed search, an empty bar). That text has not been
/// navigated to yet; once it is, the bar shows the real URL and the next
/// tick reads that instead.
#[cfg(any(target_os = "windows", test))]
pub(crate) fn address_bar_text_to_url(text: &str) -> Option<String> {
    let text = text
        .trim()
        .trim_start_matches(INVISIBLE_PREFIXES)
        .trim_end_matches(INVISIBLE_PREFIXES)
        .trim();
    if text.is_empty() || text.chars().any(char::is_whitespace) {
        return None;
    }
    if text.contains("://") {
        return Some(text.to_string());
    }
    let host_end = text.find(['/', '?', '#']).unwrap_or(text.len());
    let host = text[..host_end].split(':').next().unwrap_or("");
    let looks_like_host = (host.contains('.') && !host.starts_with('.') && !host.ends_with('.'))
        || host.eq_ignore_ascii_case("localhost")
        || text.starts_with('[');
    looks_like_host.then(|| format!("https://{text}"))
}

/// The URL to send a window's address bar to, if any: the block page for a
/// blocked site, or the original site for a parked tab that is no longer
/// blocked. Same decision `plan_actions` makes for an Apple Events tab.
#[cfg(any(target_os = "windows", test))]
pub(crate) fn plan_address_bar_action(
    address_bar_text: &str,
    blocks: &[BlockInfo],
    block_page_url: &str,
) -> Option<String> {
    let url = address_bar_text_to_url(address_bar_text)?;
    let tab = Tab {
        window_index: 1,
        tab_index: 1,
        url,
    };
    plan_actions(std::slice::from_ref(&tab), blocks, block_page_url)
        .into_iter()
        .next()
        .map(|(_, _, target)| target)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLOCK_PAGE: &str =
        "file:///C:/Program%20Files/Digital%20Habits%20Blocker/blocked/blocked.html";

    fn blocklist(domains: &[&str]) -> Vec<BlockInfo> {
        vec![BlockInfo {
            blocklist_id: "b1".into(),
            mode: "blocklist".into(),
            domains: domains.iter().map(|d| d.to_string()).collect(),
            apps: vec![],
            name: None,
            emoji: None,
            color: None,
            source: "manual",
            ends_at: None,
            started_at: None,
        }]
    }

    #[test]
    fn windows_paths_become_drive_letter_file_urls() {
        assert_eq!(
            path_str_to_file_url(r"C:\Program Files\Digital Habits Blocker\blocked\blocked.html"),
            BLOCK_PAGE
        );
    }

    #[test]
    fn unix_paths_are_unchanged() {
        assert_eq!(
            path_str_to_file_url("/Applications/Digital Habits Blocker.app/x.html"),
            "file:///Applications/Digital%20Habits%20Blocker.app/x.html"
        );
    }

    #[test]
    fn address_bar_with_elided_scheme_reads_as_https() {
        assert_eq!(
            address_bar_text_to_url("reddit.com/r/rust").as_deref(),
            Some("https://reddit.com/r/rust")
        );
        assert_eq!(
            address_bar_text_to_url("https://reddit.com/").as_deref(),
            Some("https://reddit.com/")
        );
        assert_eq!(
            address_bar_text_to_url("localhost:3000/x").as_deref(),
            Some("https://localhost:3000/x")
        );
    }

    #[test]
    fn address_bar_strips_invisible_marks() {
        assert_eq!(
            address_bar_text_to_url("\u{200E}reddit.com").as_deref(),
            Some("https://reddit.com")
        );
    }

    #[test]
    fn address_bar_search_text_is_not_a_url() {
        assert_eq!(address_bar_text_to_url(""), None);
        assert_eq!(address_bar_text_to_url("how to quit reddit"), None);
        assert_eq!(address_bar_text_to_url("reddit"), None);
        assert_eq!(address_bar_text_to_url("reddit."), None);
    }

    #[test]
    fn blocked_site_in_address_bar_goes_to_block_page() {
        let blocks = blocklist(&["reddit.com"]);
        let target = plan_address_bar_action("www.reddit.com/r/rust", &blocks, BLOCK_PAGE)
            .expect("blocked site should redirect");
        assert!(target.starts_with(&format!("{BLOCK_PAGE}?u=https%3A%2F%2Fwww.reddit.com")));
        assert_eq!(
            plan_address_bar_action("example.com", &blocks, BLOCK_PAGE),
            None
        );
    }

    #[test]
    fn parked_window_is_restored_once_unblocked() {
        let parked = format!("{BLOCK_PAGE}?u=https%3A%2F%2Freddit.com%2F&id=b1");
        assert_eq!(
            plan_address_bar_action(&parked, &blocklist(&["reddit.com"]), BLOCK_PAGE),
            None
        );
        assert_eq!(
            plan_address_bar_action(&parked, &[], BLOCK_PAGE).as_deref(),
            Some("https://reddit.com/")
        );
    }

    #[test]
    fn chromium_display_of_the_block_page_is_still_recognised() {
        // Chromium may unescape the path for display; the path fallback in
        // `is_block_page_url` must still stop a redirect loop.
        let shown = "file:///C:/Program Files/Digital Habits Blocker/blocked/blocked.html?u=https%3A%2F%2Freddit.com%2F";
        assert_eq!(
            plan_address_bar_action(shown, &blocklist(&["reddit.com"]), BLOCK_PAGE),
            None
        );
    }
}
