//! Persist schedule start-overlay media (images, voice clips) under app data.

use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use super::data::get_data_path;

pub(crate) const OVERLAY_ASSETS_DIR: &str = "overlay-assets";

fn overlay_assets_root(app: &AppHandle) -> Result<PathBuf, String> {
    let data_path = get_data_path(app);
    let parent = data_path
        .parent()
        .ok_or_else(|| "Could not resolve app data directory".to_string())?;
    Ok(parent.join(OVERLAY_ASSETS_DIR))
}

fn blocklist_assets_dir(app: &AppHandle, blocklist_id: &str) -> Result<PathBuf, String> {
    let safe_id = blocklist_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect::<String>();
    if safe_id.is_empty() {
        return Err("Invalid blocklist id".into());
    }
    Ok(overlay_assets_root(app)?.join(safe_id))
}

fn extension_from_path(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
}

/// Copy a user-selected image into overlay storage. Returns a relative path
/// (from the overlay-assets root) stored on the schedule object.
#[tauri::command]
pub fn save_overlay_image_asset(
    app: AppHandle,
    blocklist_id: String,
    asset_id: String,
    source_path: String,
) -> Result<String, String> {
    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err(format!("Image not found: {source_path}"));
    }

    let ext = extension_from_path(&source).unwrap_or_else(|| "png".into());
    let allowed = ["png", "jpg", "jpeg", "gif", "webp"];
    if !allowed.contains(&ext.as_str()) {
        return Err("Unsupported image type".into());
    }

    let dest_dir = blocklist_assets_dir(&app, &blocklist_id)?;
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;

    let filename = format!("{asset_id}.{ext}");
    let dest = dest_dir.join(&filename);
    fs::copy(&source, &dest).map_err(|e| format!("Failed to copy image: {e}"))?;

    Ok(format!("{blocklist_id}/{filename}"))
}

/// Write image bytes (from drag-and-drop or in-memory import) into overlay storage.
#[tauri::command]
pub fn save_overlay_image_asset_bytes(
    app: AppHandle,
    blocklist_id: String,
    asset_id: String,
    extension: String,
    data: Vec<u8>,
) -> Result<String, String> {
    let ext = extension.to_ascii_lowercase();
    let allowed = ["png", "jpg", "jpeg", "gif", "webp"];
    if !allowed.contains(&ext.as_str()) {
        return Err("Unsupported image type".into());
    }
    if data.is_empty() {
        return Err("Empty image file".into());
    }
    if data.len() > 10 * 1024 * 1024 {
        return Err("Image is too large (max 10 MB)".into());
    }

    let dest_dir = blocklist_assets_dir(&app, &blocklist_id)?;
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;

    let filename = format!("{asset_id}.{ext}");
    let dest = dest_dir.join(&filename);
    fs::write(&dest, &data).map_err(|e| format!("Failed to save image: {e}"))?;

    Ok(format!("{blocklist_id}/{filename}"))
}

/// Write recorded voice bytes (webm/ogg/wav) into overlay storage.
#[tauri::command]
pub fn save_overlay_voice_asset(
    app: AppHandle,
    blocklist_id: String,
    asset_id: String,
    extension: String,
    data: Vec<u8>,
) -> Result<String, String> {
    let ext = extension.to_ascii_lowercase();
    let allowed = ["webm", "ogg", "wav", "mp4", "m4a"];
    if !allowed.contains(&ext.as_str()) {
        return Err("Unsupported audio type".into());
    }
    if data.is_empty() {
        return Err("Empty audio recording".into());
    }
    if data.len() > 10 * 1024 * 1024 {
        return Err("Voice clip is too large (max 10 MB)".into());
    }

    let dest_dir = blocklist_assets_dir(&app, &blocklist_id)?;
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;

    let filename = format!("{asset_id}.{ext}");
    let dest = dest_dir.join(&filename);
    fs::write(&dest, &data).map_err(|e| format!("Failed to save voice clip: {e}"))?;

    Ok(format!("{blocklist_id}/{filename}"))
}

/// Resolve a stored relative asset path to an absolute filesystem path for `convertFileSrc`.
#[tauri::command]
pub fn resolve_overlay_asset_path(app: AppHandle, relative_path: String) -> Result<String, String> {
    if relative_path.contains("..") || relative_path.contains('\\') {
        return Err("Invalid asset path".into());
    }
    let root = overlay_assets_root(&app)?;
    let full = root.join(&relative_path);
    if !full.is_file() {
        return Err("Overlay asset not found".into());
    }
    Ok(full.to_string_lossy().into_owned())
}

/// Read arbitrary local file bytes (voice import from user-selected path).
#[tauri::command]
pub fn read_overlay_source_bytes(source_path: String) -> Result<Vec<u8>, String> {
    let path = PathBuf::from(&source_path);
    if !path.is_file() {
        return Err(format!("File not found: {source_path}"));
    }
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 10 * 1024 * 1024 {
        return Err("File is too large (max 10 MB)".into());
    }
    fs::read(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_overlay_asset(app: AppHandle, relative_path: String) -> Result<(), String> {
    if relative_path.is_empty() {
        return Ok(());
    }
    if relative_path.contains("..") || relative_path.contains('\\') {
        return Err("Invalid asset path".into());
    }
    let root = overlay_assets_root(&app)?;
    let full = root.join(&relative_path);
    if full.is_file() {
        fs::remove_file(&full).map_err(|e| e.to_string())?;
    }
    Ok(())
}
