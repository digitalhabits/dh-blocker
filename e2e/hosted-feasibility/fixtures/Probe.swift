import AppKit
import Foundation

final class Delegate: NSObject, NSApplicationDelegate {
    let directory = URL(fileURLWithPath: CommandLine.arguments[1])
    let identity = CommandLine.arguments[2]
    var window: NSWindow!
    var timer: Timer!
    func write(_ name: String, _ value: String) {
        try! value.write(to: directory.appendingPathComponent(name), atomically: true, encoding: .utf8)
    }
    @objc func saveMarker() {
        let nonce = (try? String(contentsOf: directory.appendingPathComponent("request"), encoding: .utf8)) ?? "none"
        write("gui-response", nonce)
        write("saved-marker", nonce)
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 200), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = identity
        window.isReleasedWhenClosed = false
        let button = NSButton(title: "Save marker", target: self, action: #selector(saveMarker))
        button.frame = NSRect(x: 130, y: 65, width: 220, height: 44)
        button.setAccessibilityIdentifier("save-marker")
        window.contentView!.addSubview(button)
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        write("ready", String(ProcessInfo.processInfo.processIdentifier))
        timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [self] _ in
            if let nonce = try? String(contentsOf: directory.appendingPathComponent("request"), encoding: .utf8) {
                write("response", nonce)
            }
        }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        write("polite-quit", String(Date().timeIntervalSince1970))
        return CommandLine.arguments.count > 3 && CommandLine.arguments[3] == "stubborn" ? .terminateCancel : .terminateNow
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Delegate()
app.delegate = delegate
app.run()
