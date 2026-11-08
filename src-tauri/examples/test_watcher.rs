// Standalone exerciser for the in-process app watcher.
// Run with: cargo run --example test_watcher -- Calculator
//
// Starts the real watcher with the supplied names as newly blocked apps.
// Existing matches found on the first policy sweep wait for acknowledgement,
// which this example cannot provide because it has no frontend. A match first
// seen on a later sweep can be terminated. To exercise the warning UI, run
// the full app with an app block.

fn main() {
    let names: Vec<String> = std::env::args().skip(1).collect();
    if names.is_empty() {
        eprintln!("usage: cargo run --example test_watcher -- AppName [AppName ...]");
        std::process::exit(2);
    }

    let h = redd_block_lib::app_watcher::start(None);
    h.set_apps(names.clone(), names);
    std::thread::sleep(std::time::Duration::from_secs(3));
    h.stop();
}
