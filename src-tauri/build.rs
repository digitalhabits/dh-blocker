fn main() {
    // Align the native library's LOAD segments to 16 KB pages on Android
    // (Android 15+ 16 KB page-size devices; Play Store requires it for uploads
    // from Nov 2025). NDK r28+ makes this the linker default, but we build with
    // r27, so opt in. Done via rustc-link-arg rather than .cargo/config.toml
    // rustflags, which the Tauri Android build overrides through RUSTFLAGS.
    if std::env::var("CARGO_CFG_TARGET_OS").ok().as_deref() == Some("android") {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
    }

    watch_icon_assets();

    tauri_build::build();
}

fn watch_icon_assets() {
    let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let svg = manifest_dir.join("../assets/reddblock-icon.svg");
    if svg.exists() {
        println!("cargo:rerun-if-changed={}", svg.display());
    }
    let blocked_icon = manifest_dir.join("blocked/reddblock-icon.svg");
    if blocked_icon.exists() {
        println!("cargo:rerun-if-changed={}", blocked_icon.display());
    }
    for name in [
        "icon.icns",
        "icon.png",
        "128x128.png",
        "128x128@2x.png",
        "256x256.png",
        "512x512.png",
        "1024x1024.png",
    ] {
        let path = manifest_dir.join("icons").join(name);
        if path.exists() {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
}
