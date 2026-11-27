// Classroom mode: the network side. Design in docs/classroom-design.md.
//
// A teacher opens a room; students check in to it from their own copy of
// Blocker. Enforcement of a room is the ordinary one-off block path (see
// `native_host::is_room_block`); nothing here blocks anything. This module
// only talks to the room server:
//
//   - `classroom_request` carries the frontend's calls (open, look up, join,
//     roster, leave). They go through Rust so the webview needs no CSP or
//     CORS exception, and so the only host it can reach this way is ours.
//   - the check-in loop tells the server, every `CHECK_IN_EVERY`, that this
//     computer is still in its room. It runs here and not in the webview
//     because macOS throttles WKWebView timers while the window is hidden,
//     which is the app's normal tray state: a JS interval would make every
//     student with a closed window show as "lost contact".
//
// THE PRIVACY RULE. A teacher learns THAT a student is or is not blocked,
// never WHAT the student is doing. A check-in is `{installId, token, state}`
// with `state` one of "on" / "partial" / "left". Do not add a field describing
// activity: no URL, no app, no window title. The server refuses unknown
// states and keeps nothing else, but the promise is made here.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

const DEFAULT_BASE_URL: &str = "https://apis.digitalhabits.org/classroom";
const CHECK_IN_EVERY: Duration = Duration::from_secs(20);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Emitted when a check-in learns the room is over for this student: the
/// teacher ended it early ("ended") or let this student out ("released").
/// The frontend removes the room block. If it never hears this, the block
/// simply runs to its end time, which the student agreed to at check-in.
pub const ROOM_STATUS_EVENT: &str = "classroom://room-status";

/// Where the room server lives. Fixed in release builds: an override there
/// would let anyone who can set an environment variable point a student's
/// app at a server that answers "released".
fn base_url() -> String {
    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var("DH_CLASSROOM_URL") {
        let url = url.trim().trim_end_matches('/').to_string();
        if !url.is_empty() {
            return url;
        }
    }
    DEFAULT_BASE_URL.to_string()
}

/// A request path the frontend may ask for: under the classroom base, with
/// nothing that could turn it into another host or climb out of the prefix.
fn path_is_safe(path: &str) -> bool {
    path.starts_with('/')
        && !path.starts_with("//")
        && !path.contains("..")
        && !path.contains("://")
        && !path.contains('\\')
        && !path.contains('@')
        && !path.contains(char::is_whitespace)
        && path.len() <= 512
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        // A generic name: nothing about the user or the machine.
        .user_agent(concat!("dh-blocker/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

#[derive(Debug, Clone, Serialize)]
pub struct ClassroomResponse {
    pub status: u16,
    pub body: Value,
}

async fn send(
    method: &str,
    path: &str,
    body: Option<&Value>,
    teacher_key: Option<&str>,
) -> Result<ClassroomResponse, String> {
    if !path_is_safe(path) {
        return Err("bad path".into());
    }
    let url = format!("{}{}", base_url(), path);
    let client = client()?;
    let mut request = match method {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        _ => return Err("bad method".into()),
    };
    if let Some(key) = teacher_key.filter(|k| !k.is_empty()) {
        request = request.bearer_auth(key);
    }
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request.send().await.map_err(|_| "offline".to_string())?;
    let status = response.status().as_u16();
    // A non-JSON answer (a proxy's error page, say) reads as an empty body:
    // callers decide from the status.
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    Ok(ClassroomResponse { status, body })
}

/// One call to the room server on the frontend's behalf. `Err` means the
/// server could not be reached; an HTTP error comes back as `Ok` with its
/// status, so the frontend can tell "no such room" from "no internet".
#[tauri::command]
pub async fn classroom_request(
    method: String,
    path: String,
    body: Option<Value>,
    teacher_key: Option<String>,
) -> Result<ClassroomResponse, String> {
    send(&method, &path, body.as_ref(), teacher_key.as_deref()).await
}

// ---- The name suggested on the join screen ---------------------------------

fn tidy_name(raw: &str) -> String {
    let name: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    name.chars().take(60).collect()
}

/// macOS writes "Amira's MacBook Air" as the hostname "Amiras-MacBook-Air.local".
fn tidy_host_name(raw: &str) -> String {
    let host = raw.trim();
    let host = host.strip_suffix(".local").unwrap_or(host);
    tidy_name(&host.replace('-', " "))
}

#[cfg(target_os = "macos")]
fn account_full_name() -> Option<String> {
    let output = std::process::Command::new("/usr/bin/id")
        .arg("-F")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(target_os = "windows")]
fn account_full_name() -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::Security::Authentication::Identity::{GetUserNameExW, NameDisplay};

    // Blank for many local accounts, where Windows only has the short
    // account name; the caller then falls back to the computer's name.
    let mut size: u32 = 256;
    let mut buffer = vec![0u16; size as usize];
    // SAFETY: `buffer` holds `size` UTF-16 units and outlives the call.
    let ok = unsafe { GetUserNameExW(NameDisplay, Some(PWSTR(buffer.as_mut_ptr())), &mut size) };
    if !ok {
        return None;
    }
    let len = (size as usize).min(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..len]))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn account_full_name() -> Option<String> {
    None
}

/// The name the join screen starts with: the full name on the user account,
/// else the computer's name. The student sees it and can change it before
/// anything is sent; only the name they confirm leaves this computer.
#[tauri::command]
pub fn classroom_suggested_name() -> String {
    if let Some(name) = account_full_name().map(|n| tidy_name(&n)) {
        if !name.is_empty() {
            return name;
        }
    }
    sysinfo::System::host_name()
        .map(|h| tidy_host_name(&h))
        .unwrap_or_default()
}

// ---- The check-in loop -----------------------------------------------------

/// What the loop needs about the room this computer is checked in to, read
/// from `classroom.joined` in the data file.
#[derive(Debug, Clone, PartialEq, Eq)]
struct JoinedRoom {
    room_id: String,
    install_id: String,
    token: String,
}

fn text_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
}

/// The room to check in to at `now_ms`, if any.
///
/// Only while the room's block is actually being enforced: the `activeBlocks`
/// entry carrying this room's id must exist and be inside its time window.
/// Reporting "blocking on" for a room whose block has gone would be a lie to
/// the teacher, which is worse than the silence it replaces.
fn joined_room(data: &Value, now_ms: u64) -> Option<JoinedRoom> {
    let joined = data.get("classroom")?.get("joined")?;
    let room_id = text_field(joined, "roomId")?;
    let install_id = text_field(joined, "installId")?;
    let token = text_field(joined, "token")?;

    let enforced = data
        .get("activeBlocks")
        .and_then(|v| v.as_array())
        .is_some_and(|blocks| {
            blocks.iter().any(|ab| {
                let start = ab.get("startTime").and_then(|v| v.as_u64()).unwrap_or(0);
                let end = ab.get("endTime").and_then(|v| v.as_u64()).unwrap_or(0);
                ab.get("roomId").and_then(|v| v.as_str()) == Some(room_id)
                    && now_ms >= start
                    && now_ms < end
            })
        });
    if !enforced {
        return None;
    }
    Some(JoinedRoom {
        room_id: room_id.to_string(),
        install_id: install_id.to_string(),
        token: token.to_string(),
    })
}

/// "on" when nothing is known to be wrong, "partial" when a running browser
/// is known not to be covered. Never more detail than that.
///
/// This reports what the app already knows; it does not go looking. The
/// compliance scan that would find a disabled extension is opt-in and can
/// raise macOS data-access prompts, so a room must not switch it on. What is
/// free: an Automation permission the user denied for a running browser
/// (macOS), and a grace countdown the opt-in enforcer is already running.
fn blocking_state(app: &AppHandle) -> &'static str {
    let mut partial = false;

    if let Some(state) = app.try_state::<crate::commands::enforcement::EnforcerState>() {
        if let Ok(slot) = state.0.lock() {
            partial |= slot.as_ref().is_some_and(|h| h.has_open_issues());
        }
    }

    #[cfg(target_os = "macos")]
    if let Some(state) = app.try_state::<crate::commands::web_automation::WebAutomationState>() {
        if let Ok(slot) = state.0.lock() {
            partial |= slot.as_ref().is_some_and(|h| {
                h.permission_status()
                    .iter()
                    .any(|p| p.running && p.state == crate::web_automation::PermState::Denied)
            });
        }
    }

    if partial {
        "partial"
    } else {
        "on"
    }
}

fn check_in_body(room: &JoinedRoom, state: &str) -> Value {
    json!({
        "installId": room.install_id,
        "token": room.token,
        "state": state,
    })
}

/// What a check-in's answer means for this student, if anything.
fn room_status_from(response: &ClassroomResponse) -> Option<&'static str> {
    if response.status != 200 {
        // Unknown room, refused token, server error: keep blocking to the end
        // time. Only an explicit answer from the server lets a student out.
        return None;
    }
    match response.body.get("status").and_then(|v| v.as_str()) {
        Some("ended") => Some("ended"),
        Some("released") => Some("released"),
        _ => None,
    }
}

async fn check_in_once(app: &AppHandle) {
    let Some(path) = crate::commands::canonical_data_path(app) else {
        return;
    };
    let Some(data) = crate::data_cache::read(&path) else {
        return;
    };
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let Some(room) = joined_room(&data, now_ms) else {
        return;
    };

    let body = check_in_body(&room, blocking_state(app));
    let request_path = format!("/rooms/{}/checkin", room.room_id);
    match send("POST", &request_path, Some(&body), None).await {
        Ok(response) => {
            if let Some(status) = room_status_from(&response) {
                log::info!("classroom: room {status} for this computer");
                let _ = app.emit(
                    ROOM_STATUS_EVENT,
                    json!({ "roomId": room.room_id, "status": status }),
                );
            }
        }
        // Offline. The roster shows "lost contact" until we get through.
        Err(_) => log::debug!("classroom: check-in did not reach the server"),
    }
}

/// Start the check-in loop. It idles (one cached file read per tick) unless
/// this computer is checked in to a room.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            check_in_once(&app).await;
            tokio::time::sleep(CHECK_IN_EVERY).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data_with(joined: Value, active_blocks: Value) -> Value {
        json!({ "classroom": { "joined": joined }, "activeBlocks": active_blocks })
    }

    fn joined() -> Value {
        json!({ "roomId": "room-1", "installId": "install-1", "token": "secret" })
    }

    #[test]
    fn checks_in_only_while_the_room_block_is_enforced() {
        let now = 1_000_000;
        let live = json!([{ "roomId": "room-1", "startTime": now - 10, "endTime": now + 10 }]);
        assert_eq!(
            joined_room(&data_with(joined(), live), now),
            Some(JoinedRoom {
                room_id: "room-1".into(),
                install_id: "install-1".into(),
                token: "secret".into(),
            })
        );

        // Ended, not started, a different room, no block at all, no end time.
        for blocks in [
            json!([{ "roomId": "room-1", "startTime": now - 20, "endTime": now }]),
            json!([{ "roomId": "room-1", "startTime": now + 5, "endTime": now + 10 }]),
            json!([{ "roomId": "room-2", "startTime": now - 10, "endTime": now + 10 }]),
            json!([{ "blocklistId": "own", "startTime": now - 10, "endTime": now + 10 }]),
            json!([{ "roomId": "room-1", "startTime": now - 10 }]),
            json!([]),
        ] {
            assert_eq!(
                joined_room(&data_with(joined(), blocks.clone()), now),
                None,
                "{blocks}"
            );
        }
    }

    #[test]
    fn incomplete_join_data_means_no_check_in() {
        let now = 1_000_000;
        let live = json!([{ "roomId": "room-1", "startTime": now - 10, "endTime": now + 10 }]);
        for broken in [
            json!({ "installId": "install-1", "token": "secret" }),
            json!({ "roomId": "room-1", "token": "secret" }),
            json!({ "roomId": "room-1", "installId": "install-1", "token": "" }),
            json!(null),
        ] {
            assert_eq!(joined_room(&data_with(broken, live.clone()), now), None);
        }
        assert_eq!(joined_room(&json!({ "activeBlocks": live }), now), None);
    }

    /// The privacy rule, as a test: a check-in is exactly these three fields.
    #[test]
    fn a_check_in_says_nothing_about_activity() {
        let room = JoinedRoom {
            room_id: "room-1".into(),
            install_id: "install-1".into(),
            token: "secret".into(),
        };
        let body = check_in_body(&room, "on");
        let mut keys: Vec<&str> = body
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["installId", "state", "token"]);
    }

    #[test]
    fn only_an_explicit_answer_lets_a_student_out() {
        let answer = |status: u16, body: Value| ClassroomResponse { status, body };
        assert_eq!(
            room_status_from(&answer(200, json!({ "status": "ended" }))),
            Some("ended")
        );
        assert_eq!(
            room_status_from(&answer(200, json!({ "status": "released" }))),
            Some("released")
        );
        for kept in [
            answer(200, json!({ "status": "active" })),
            answer(200, Value::Null),
            answer(404, json!({ "status": "ended" })),
            answer(403, json!({ "status": "released" })),
            answer(500, Value::Null),
        ] {
            assert_eq!(room_status_from(&kept), None, "{kept:?}");
        }
    }

    #[test]
    fn request_paths_cannot_leave_the_classroom_server() {
        for ok in [
            "/rooms",
            "/rooms/lookup?code=ABC234",
            "/rooms/abc-1/checkin",
        ] {
            assert!(path_is_safe(ok), "{ok}");
        }
        for bad in [
            "rooms",
            "//evil.invalid/rooms",
            "/../hub/secret",
            "/rooms/https://evil.invalid",
            "/rooms@evil.invalid",
            "/rooms\\..\\x",
            "/rooms ",
            "",
        ] {
            assert!(!path_is_safe(bad), "{bad}");
        }
    }

    /// The real wire, against a real room server. Ignored by default: it
    /// needs one running. Start `PORT=3909 node apis/classroom.js` in dh-apis,
    /// then run
    /// `DH_CLASSROOM_URL=http://127.0.0.1:3909/classroom cargo test --lib classroom::tests::live -- --ignored`.
    #[test]
    #[ignore = "needs a running room server; see the comment above"]
    fn live_server_round_trip() {
        tauri::async_runtime::block_on(async {
            let ends_at = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
                + 10 * 60_000;
            let opened = send(
                "POST",
                "/rooms",
                Some(&json!({
                    "name": "Live test", "mode": "blocklist", "websites": ["videos.invalid"],
                    "apps": [], "endsAt": ends_at, "leave": { "type": "challenge", "words": 15 }
                })),
                None,
            )
            .await
            .expect("server reachable");
            assert_eq!(opened.status, 201, "{:?}", opened.body);
            let room_id = opened.body["roomId"].as_str().unwrap().to_string();
            let teacher_key = opened.body["teacherKey"].as_str().unwrap().to_string();

            let install_id = "11111111-1111-4111-8111-111111111111";
            let joined = send(
                "POST",
                &format!("/rooms/{room_id}/join"),
                Some(&json!({ "installId": install_id, "name": "Rust", "nameEdited": false })),
                None,
            )
            .await
            .unwrap();
            assert_eq!(joined.status, 200);
            let room = JoinedRoom {
                room_id: room_id.clone(),
                install_id: install_id.into(),
                token: joined.body["token"].as_str().unwrap().into(),
            };

            let path = format!("/rooms/{room_id}/checkin");
            let active = send("POST", &path, Some(&check_in_body(&room, "partial")), None)
                .await
                .unwrap();
            assert_eq!(room_status_from(&active), None);

            let roster_path = format!("/rooms/{room_id}/roster");
            let roster = send("GET", &roster_path, None, Some(&teacher_key))
                .await
                .unwrap();
            assert_eq!(roster.body["students"][0]["state"], "partial");
            assert_eq!(
                send("GET", &roster_path, None, None).await.unwrap().status,
                403
            );

            let end_path = format!("/rooms/{room_id}/end");
            assert_eq!(
                send("POST", &end_path, None, Some(&teacher_key))
                    .await
                    .unwrap()
                    .status,
                200
            );
            let ended = send("POST", &path, Some(&check_in_body(&room, "on")), None)
                .await
                .unwrap();
            assert_eq!(room_status_from(&ended), Some("ended"));
        });
    }

    #[test]
    fn suggested_names_are_tidied() {
        assert_eq!(tidy_name("  Amira   Hassan \n"), "Amira Hassan");
        assert_eq!(
            tidy_host_name("Amiras-MacBook-Air.local"),
            "Amiras MacBook Air"
        );
        assert_eq!(tidy_name(&"x".repeat(200)).chars().count(), 60);
    }
}
