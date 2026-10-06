use serde::{Deserialize, Serialize};

// --- Authorization ---

#[derive(Debug, Serialize, Deserialize)]
pub struct AuthorizationRequest {}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationResponse {
    pub granted: bool,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// --- Website Blocking ---

#[derive(Debug, Serialize, Deserialize)]
pub struct BlockWebsitesRequest {
    pub domains: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockWebsitesResponse {
    pub success: bool,
    #[serde(default)]
    pub blocked_count: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UnblockRequest {}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct SuccessResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// --- App Blocking ---

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockAppsRequest {
    pub token_data: Vec<String>, // Base64-encoded ApplicationToken data
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockAppsResponse {
    pub success: bool,
    #[serde(default)]
    pub blocked_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshActivityTokensRequest {
    pub application_token_data: Vec<String>,
    pub category_token_data: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshActivityTokensResponse {
    pub success: bool,
    pub supported: bool,
    #[serde(default)]
    pub application_tokens: Vec<String>,
    #[serde(default)]
    pub category_tokens: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// --- Combined Block (matches existing frontend API) ---

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartBlockRequest {
    /// Legacy field: domains to BLOCK (blocklist semantics). Kept for back-compat.
    pub domains: Vec<String>,
    pub app_token_data: Option<Vec<String>>,
    pub category_token_data: Option<Vec<String>>,
    /// Pre-resolved blocked/allowed split of the active manual union. When
    /// allowed_* fields are present, Swift applies `.all(except:)` semantics.
    /// All optional so older payloads decode unchanged.
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub blocked_domains: Option<Vec<String>>,
    #[serde(default)]
    pub allowed_domains: Option<Vec<String>>,
    #[serde(default)]
    pub blocked_app_token_data: Option<Vec<String>>,
    #[serde(default)]
    pub allowed_app_token_data: Option<Vec<String>>,
    /// Blocklist label for shield copy; omit on older clients.
    #[serde(default)]
    pub blocklist_emoji: Option<String>,
    #[serde(default)]
    pub blocklist_name: Option<String>,
    #[serde(default)]
    pub blocklist_color_hex: Option<String>,
    #[serde(default)]
    pub block_start_ms: Option<f64>,
    #[serde(default)]
    pub block_end_ms: Option<f64>,
    /// Shield-attribution display fields for the earliest-started active
    /// allow-mode block (the fields above describe the overall display winner,
    /// which may be a blocklist block). Omit when no allowlist block is active.
    #[serde(default)]
    pub allowlist_blocklist_emoji: Option<String>,
    #[serde(default)]
    pub allowlist_blocklist_name: Option<String>,
    #[serde(default)]
    pub allowlist_blocklist_color_hex: Option<String>,
    #[serde(default)]
    pub allowlist_block_start_ms: Option<f64>,
    #[serde(default)]
    pub allowlist_block_end_ms: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartBlockResponse {
    pub success: bool,
    #[serde(default)]
    pub websites_blocked: usize,
}

// --- Scheduling ---

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleBlockRequest {
    pub id: Option<String>,
    pub start_hour: u32,
    pub start_minute: u32,
    pub end_hour: u32,
    pub end_minute: u32,
    pub domains: Option<Vec<String>>,
    pub app_token_data: Option<Vec<String>>,
    pub category_token_data: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleEntryRequest {
    pub id: String,
    pub start_hour: u32,
    pub start_minute: u32,
    pub end_hour: u32,
    pub end_minute: u32,
    pub domains: Option<Vec<String>>,
    pub app_token_data: Option<Vec<String>>,
    pub category_token_data: Option<Vec<String>>,
    /// Optional weekday filter: Mon=0 … Sun=6. If present, extension only applies when current day is in this list.
    pub days: Option<Vec<u8>>,
    /// Whether the DeviceActivity schedule should repeat.
    pub repeats: Option<bool>,
    /// Optional active window start for this schedule entry.
    pub active_from_timestamp_ms: Option<f64>,
    /// Optional active window end for this schedule entry.
    pub active_until_timestamp_ms: Option<f64>,
    /// Whether this schedule entry is currently paused.
    pub is_paused: Option<bool>,
    /// Optional pause expiry for this schedule entry.
    pub pause_end_timestamp_ms: Option<f64>,
    /// Optional blocklist presentation for shield snapshot.
    pub blocklist_emoji: Option<String>,
    pub blocklist_name: Option<String>,
    pub blocklist_color_hex: Option<String>,
    /// "allowlist" when this entry's domains/tokens are ALLOWED items;
    /// absent/"blocklist" = blocked items (legacy semantics).
    #[serde(default)]
    pub mode: Option<String>,
    /// Focus space id, so start warnings can tell one space carrying on from another starting.
    #[serde(default)]
    pub blocklist_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSchedulesRequest {
    pub schedules: Vec<ScheduleEntryRequest>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnscheduleBlockRequest {
    pub id: Option<String>,
}

// --- One-off DeviceActivity (pause resume / block end) ---

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterOneOffActivityRequest {
    pub activity_name: String,
    pub start_timestamp_ms: f64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetResumePayloadRequest {
    pub block_id: String,
    pub domains: Vec<String>,
    pub app_token_data: Option<Vec<String>>,
    pub category_token_data: Option<Vec<String>>,
    /// "allowlist" when this payload's items are ALLOWED items.
    #[serde(default)]
    pub mode: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetBlockEndStateRequest {
    pub block_id: String,
    pub domains: Vec<String>,
    pub app_token_data: Option<Vec<String>>,
    pub category_token_data: Option<Vec<String>>,
    /// "allowlist" when this payload's items are ALLOWED items.
    #[serde(default)]
    pub mode: Option<String>,
}

// --- Start warnings (notifications before a focus space starts) ---

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWarningStrings {
    pub start_title_fmt: String,
    pub block_body_fmt: String,
    pub allow_body_fmt: String,
    pub resume_title_fmt: String,
    pub multi_title_fmt: String,
    pub multi_body_fmt: String,
    pub unnamed_space: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualResumeWarning {
    pub id: String,
    pub name: Option<String>,
    pub emoji: Option<String>,
    pub mode: Option<String>,
    pub resume_at_ms: f64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetStartWarningsRequest {
    pub enabled: bool,
    pub locale: String,
    pub strings: StartWarningStrings,
    #[serde(default)]
    pub manual_resumes: Vec<ManualResumeWarning>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWarningsResponse {
    pub success: bool,
    /// Notification permission status.
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub scheduled: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NotificationPermissionRequest {}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPermissionResponse {
    pub status: String,
    #[serde(default)]
    pub granted: bool,
}

// --- Activity Picker ---

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPickerRequest {
    pub initial_application_token_data: Option<Vec<String>>,
    pub initial_category_token_data: Option<Vec<String>>,
    /// "allowlist" when picking for an allow-mode focus space — the iOS picker
    /// then expands category picks into individual member app tokens.
    #[serde(default)]
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPickerResponse {
    pub cancelled: bool,
    #[serde(default)]
    pub application_tokens: Vec<String>,
    #[serde(default)]
    pub category_tokens: Vec<String>,
    #[serde(default)]
    pub application_count: usize,
    #[serde(default)]
    pub category_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::{InvokeResponseBody, IpcResponse};

    // Round-trips through Tauri's own IPC JSON path, so no serde_json dev-dependency is needed.
    fn from_json<T: serde::de::DeserializeOwned>(json: &str) -> T {
        InvokeResponseBody::Json(json.to_string())
            .deserialize()
            .unwrap()
    }

    fn to_json<T: Serialize>(value: T) -> String {
        match value.body().unwrap() {
            InvokeResponseBody::Json(s) => s,
            InvokeResponseBody::Raw(_) => panic!("expected JSON"),
        }
    }

    const STRINGS: &str = r#"{"startTitleFmt":"a","blockBodyFmt":"b","allowBodyFmt":"c","resumeTitleFmt":"d","multiTitleFmt":"e","multiBodyFmt":"f","unnamedSpace":"g"}"#;

    #[test]
    fn set_start_warnings_request_reads_camel_case_and_defaults_manual_resumes() {
        let req: SetStartWarningsRequest = from_json(&format!(
            r#"{{"enabled":true,"locale":"pt-PT","strings":{STRINGS}}}"#
        ));
        assert!(req.enabled);
        assert_eq!(req.locale, "pt-PT");
        assert_eq!(req.strings.start_title_fmt, "a");
        assert_eq!(req.strings.unnamed_space, "g");
        assert!(req.manual_resumes.is_empty());

        let req: SetStartWarningsRequest = from_json(&format!(
            r#"{{"enabled":false,"locale":"en","strings":{STRINGS},"manualResumes":[{{"id":"x","name":"Work","emoji":null,"mode":"allowlist","resumeAtMs":1700000000000}}]}}"#
        ));
        assert_eq!(req.manual_resumes.len(), 1);
        assert_eq!(req.manual_resumes[0].id, "x");
        assert_eq!(req.manual_resumes[0].mode.as_deref(), Some("allowlist"));
        assert_eq!(req.manual_resumes[0].resume_at_ms, 1_700_000_000_000.0);
    }

    #[test]
    fn schedule_entry_keeps_blocklist_id() {
        let entry: ScheduleEntryRequest = from_json(
            r#"{"id":"s1","startHour":9,"startMinute":0,"endHour":17,"endMinute":0,"blocklistId":"space-1"}"#,
        );
        assert_eq!(entry.blocklist_id.as_deref(), Some("space-1"));
        assert!(to_json(entry).contains(r#""blocklistId":"space-1""#));
    }

    #[test]
    fn start_warnings_response_serializes_camel_case() {
        let json = to_json(StartWarningsResponse {
            success: true,
            status: "authorized".into(),
            scheduled: 3,
            error: None,
        });
        assert!(json.contains(r#""scheduled":3"#));
        assert!(json.contains(r#""status":"authorized""#));
        assert!(!json.contains("error"));

        let resp: StartWarningsResponse = from_json(r#"{"success":true}"#);
        assert_eq!((resp.status.as_str(), resp.scheduled), ("", 0));
        let perm: NotificationPermissionResponse = from_json(r#"{"status":"denied"}"#);
        assert!(!perm.granted);
    }
}
