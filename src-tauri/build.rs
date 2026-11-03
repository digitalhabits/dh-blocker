fn main() {
    // Build the Safari bridge dylib before tauri_build::build(). Tauri's
    // bundle.macOS.frameworks lists target/safari-bridge/libsafari_bridge.dylib
    // and build.rs validates it exists — on a clean CI checkout the file is
    // missing until we compile it here first.
    if std::env::var("CARGO_CFG_TARGET_OS").ok().as_deref() == Some("macos") {
        build_and_link_safari_bridge();
    }

    watch_icon_assets();

    tauri_build::build();

    // Tauri embeds its application manifest only in binary targets. Rust's
    // library test executable also links the dialog plugin, whose import of
    // TaskDialogIndirect requires Common Controls v6 before main can run.
    // Without this dependency it exits with STATUS_ENTRYPOINT_NOT_FOUND.
    // Generate a manifest for the otherwise unmanifested tests. Binary targets
    // already carry Tauri's full manifest as a resource, so disable linker
    // generation for those targets to avoid a duplicate MANIFEST resource.
    if std::env::var("CARGO_CFG_TARGET_OS").ok().as_deref() == Some("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").ok().as_deref() == Some("msvc")
    {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
        println!("cargo:rustc-link-arg-bins=/MANIFEST:NO");
    }
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

/// Compile + link the SafariServices Swift bridge on macOS desktop targets.
///
/// We need to call SFSafariExtensionManager and SFSafariApplication from the
/// main `redd-block` process (a sidecar binary fails — see the doc-comment in
/// src-tauri/safari-bridge/safari-bridge.swift for why). The bridge is a tiny
/// dylib with two @_cdecl functions that the Rust side calls via `extern "C"`.
///
/// Gate on CARGO_CFG_TARGET_OS, not #[cfg(target_os = "macos")]: build.rs is
/// compiled for the *host*, so cfg(target_os) is always macos when developing
/// on a Mac and would wrongly run this step during iOS cross-compiles.
fn build_and_link_safari_bridge() {
    use std::path::PathBuf;
    use std::process::Command;

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let project_root = manifest_dir
        .parent()
        .expect("manifest_dir has a parent")
        .to_path_buf();
    let script = project_root.join("scripts/build-safari-bridge.sh");
    let src = manifest_dir.join("safari-bridge/safari-bridge.swift");
    let bridge_out_dir = manifest_dir.join("target/safari-bridge");
    let dylib = bridge_out_dir.join("libsafari_bridge.dylib");

    println!("cargo:rerun-if-changed={}", src.display());
    println!("cargo:rerun-if-changed={}", script.display());

    let status = Command::new("bash")
        .arg(&script)
        .env("SAFARI_BRIDGE_OUT_DIR", &bridge_out_dir)
        .status()
        .expect("failed to invoke scripts/build-safari-bridge.sh");
    if !status.success() {
        panic!("scripts/build-safari-bridge.sh exited with {status}");
    }
    if !dylib.exists() {
        panic!(
            "expected libsafari_bridge.dylib at {} after build, but it's missing",
            dylib.display()
        );
    }

    // Runtime resolution: the dylib's install_name is
    // `@rpath/libsafari_bridge.dylib`. We add two rpaths:
    //
    //   @executable_path/../Frameworks/
    //     The location Tauri puts the dylib in the bundled .app
    //     (via bundle.macOS.frameworks in tauri.conf.json). This is
    //     the path users actually run from.
    //
    //   <absolute path to target/safari-bridge/>
    //     Where the build script just put the dylib. Lets `cargo run`
    //     and `cargo test` resolve the dylib at dev time without us
    //     having to copy it next to the binary.
    println!(
        "cargo:rustc-link-search=native={}",
        bridge_out_dir.display()
    );
    println!("cargo:rustc-link-lib=dylib=safari_bridge");
    println!("cargo:rustc-link-lib=framework=SafariServices");
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks/");
    println!(
        "cargo:rustc-link-arg=-Wl,-rpath,{}",
        bridge_out_dir.display()
    );
}
