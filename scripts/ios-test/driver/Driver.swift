import XCTest

final class Driver: XCTestCase {
    private let blocker = XCUIApplication(bundleIdentifier: "com.reddblock")
    private let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
    private let target = "example.org"
    private let control = "example.com"
    private var newSpaceTitle: XCUIElement {
        web.staticTexts.matching(NSPredicate(format: "label ==[c] %@", "New focus space (block)")).firstMatch
    }
    private var web: XCUIElement { blocker.webViews.firstMatch }

    override func setUp() {
        continueAfterFailure = false
    }

    func testReadWebViewAndCaptureSafari() throws {
        blocker.activate()
        try observe(blocker, name: "Blocker home")
        try observe(web, name: "Blocker WKWebView")
        safari.activate()
        try observe(safari, name: "Safari foreground")
    }

    func testFreshWebsiteLifecycle() throws {
        let (name, end) = try configuration()
        let start = end.addingTimeInterval(-20 * 60)
        let calendar = Calendar.current
        guard calendar.isDate(start, inSameDayAs: end), calendar.isDateInToday(end) else {
            throw DriverFailure.expected("a 20-minute schedule ending today, away from midnight")
        }

        try assertSafari(target, restricted: false, phase: "01 baseline target")
        try assertSafari(control, restricted: false, phase: "02 baseline control")
        blocker.activate()
        guard !web.staticTexts[name].exists else { throw DriverFailure.expected("a new, unique fixture name") }
        let previousSwitches = focusSpaceSwitches()
        try createSchedule(name: name, start: start, end: end)
        try enableSchedule(name: name, start: start, end: end)
        try observe(blocker, name: "03 owned schedule saved", includeTree: false)

        try assertSafari(target, restricted: true, phase: "04 target restricted", attempts: 3, before: end)
        try assertSafari(control, restricted: false, phase: "05 control still loads")
        guard Date() < end else { throw DriverFailure.expected("target and control observations before the fixture ends") }

        // Keep the device and Safari active around the real DeviceActivity
        // interval end. Blocker has been backgrounded since before the proof.
        try waitForExpiry(end)
        try assertSafari(target, restricted: false, phase: "06 target loads after expiry", attempts: 3)
        try assertSafari(control, restricted: false, phase: "07 control still loads after expiry")
        try removeOwnedFixture(name: name, after: end)
        guard focusSpaceSwitches() == previousSwitches else {
            throw DriverFailure.expected("the previous focus spaces and their on/off states to remain unchanged")
        }
        try observe(blocker, name: "08 owned fixture removed", includeTree: false)
    }

    func testRecoverOwnedFixture() throws {
        let (name, end) = try configuration()
        blocker.activate()
        if newSpaceTitle.exists {
            guard web.textFields["NAME"].value as? String == name else {
                throw DriverFailure.expected("only the reported run's unsaved draft")
            }
            dismissEditorDraft()
            guard newSpaceTitle.waitForNonExistence(timeout: 5) else {
                throw DriverFailure.expected("the owned draft to close")
            }
        }
        try require(web.buttons["Block"], "Blocker focus space list")
        if web.switches["Turn on \(name)"].exists || web.switches["Turn off \(name)"].exists {
            guard Date() >= end else { throw DriverFailure.expected("the owned fixture's scheduled window to end") }
            try assertSafari(target, restricted: false, phase: "Recovery verifies expiry")
            try removeOwnedFixture(name: name, after: end)
        }
        try observe(blocker, name: "Owned fixture absent")
    }

    private func focusSpaceSwitches() -> [String] {
        web.switches.matching(NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@",
            "Turn on ", "Turn off ")).allElementsBoundByIndex.map(\.label).sorted()
    }

    private func configuration() throws -> (String, Date) {
        let env = ProcessInfo.processInfo.environment
        guard let name = env["REDD_IOS_TEST_FIXTURE"],
              name.range(of: #"^Rbtest[a-p]{8}$"#, options: .regularExpression) != nil,
              let deadline = env["REDD_IOS_TEST_END"],
              let end = ISO8601DateFormatter().date(from: deadline) else {
            throw DriverFailure.expected("the host journal's exact fixture name and deadline")
        }
        return (name, end)
    }

    private func createSchedule(name: String, start: Date, end: Date) throws {
        guard !newSpaceTitle.exists else {
            throw DriverFailure.expected("Blocker home without an existing unsaved editor")
        }
        try tap(web.buttons["Block"], named: "Block")
        defer { dismissEditorDraft() }
        try require(newSpaceTitle, "New focus space")
        let nameField = web.textFields["NAME"]
        try enterWebKeys(name, into: nameField, named: "Name")
        guard nameField.value as? String == name else {
            try observe(blocker, name: "Fixture name field")
            throw DriverFailure.expected("the exact fixture name in the editor")
        }
        let website = web.textFields.matching(NSPredicate(format: "placeholderValue == %@", "e.g., facebook.com")).firstMatch
        if !website.exists { try tap(button(prefix: "What to block"), named: "What to block") }
        try enterWebKeys(target + " ", into: website, named: "website")
        try require(web.staticTexts[target], "the exact fixture website chip")

        try tap(button(prefix: "When to block"), named: "When to block")
        try tap(web.switches["Daily"], named: "Daily")
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm"
        let startValue = formatter.string(from: start)
        let endValue = formatter.string(from: end)
        let startField = web.textFields["Start time"]
        let endField = web.textFields["End time"]
        try enterWebKeys(startValue.replacingOccurrences(of: ":", with: ""), into: startField, named: "Start time")
        try enterWebKeys(endValue.replacingOccurrences(of: ":", with: ""), into: endField, named: "End time")
        try tap(web.switches["Date"], named: "Date")
        try setToday(end)
        guard startField.value as? String == startValue, endField.value as? String == endValue else {
            throw DriverFailure.expected("the intended 20-minute window \(startValue)–\(endValue)")
        }

        // The app lets a Flexible space be stopped without a challenge
        // between its windows. Only the new fixture gets this setting.
        try tap(button(prefix: "Advanced options"), named: "Advanced options")
        let editingOptions = web.buttons["Stricter only"]
        try require(editingOptions, "schedule editing options")
        for _ in 0..<2 where editingOptions.frame.midY > web.frame.maxY - 220 {
            web.swipeUp(velocity: .slow)
        }
        try tap(editingOptions, named: "schedule editing options")
        try tap(button(prefix: "Any change"), named: "allow editing outside the fixture window")
        try require(web.buttons["Any change"], "fixture editing choice")
        guard Date() < end.addingTimeInterval(-60) else { throw DriverFailure.expected("at least a minute remaining before Save") }
        try observe(blocker, name: "Owned schedule configuration", includeTree: false)
        print("REDD_IOS_FIXTURE_SAVE_REQUESTED \(name)")
        try tap(web.buttons["Save"], named: "Save")
        try require(web.staticTexts[name], name)
        print("REDD_IOS_FIXTURE_SAVED \(name)")
    }

    private func enableSchedule(name: String, start: Date, end: Date) throws {
        guard Date() < end.addingTimeInterval(-45) else { throw DriverFailure.expected("at least 45 seconds before the fixture ends") }
        try tap(web.switches["Turn on \(name)"], named: "Turn on \(name)")
        try require(web.staticTexts.matching(NSPredicate(format: "label BEGINSWITH[c] %@ AND label CONTAINS[c] %@",
            "Start ", name)).firstMatch, "the owned fixture's start confirmation")
        try require(web.staticTexts[target], "the confirmation contains the fixture's target")
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm"
        let startValue = formatter.string(from: start)
        let endValue = formatter.string(from: end)
        try require(web.staticTexts.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@",
            startValue, endValue)).firstMatch, "the intended schedule in the start confirmation")
        try tap(web.buttons["Start"], named: "Start owned fixture")
        try require(web.switches["Turn off \(name)"], "the owned fixture is switched on")
    }

    private func setToday(_ date: Date) throws {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "d MMM yyyy"
        let expected = formatter.string(from: date)
        let expectedLabel = web.staticTexts[expected]
        if expectedLabel.exists { return }

        let defaultDate = try XCTUnwrap(Calendar.current.date(byAdding: .day, value: 6, to: Date()))
        let defaultLabel = web.staticTexts[formatter.string(from: defaultDate)]
        try require(defaultLabel, "schedule end date")
        // The overlaid date text ignores pointer events. Tap its on-screen
        // centre to reach the native date input underneath.
        defaultLabel.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let calendar = blocker.datePickers.firstMatch
        try require(calendar, "the native schedule calendar")
        let today = calendar.buttons.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "Today,")).firstMatch
        if !today.exists && !Calendar.current.isDate(defaultDate, equalTo: date, toGranularity: .month) {
            try tap(calendar.buttons["DatePicker.PreviousMonth"], named: "previous calendar month")
        }
        try tap(today, named: "Today in the schedule calendar")
        if blocker.buttons["Done"].exists && blocker.buttons["Done"].isHittable {
            blocker.buttons["Done"].tap()
        }
        try require(expectedLabel, "today's exact schedule end date \(expected)")
    }

    private func waitForExpiry(_ end: Date) throws {
        let remaining = end.timeIntervalSinceNow
        guard remaining >= -20, remaining < 6 * 60 else { throw DriverFailure.expected("the owned fixture's bounded expiry") }
        // XCTest is waiting with Safari foregrounded, not a fake device clock.
        if remaining > 0 { Thread.sleep(forTimeInterval: remaining) }
    }

    private func assertSafari(_ host: String, restricted: Bool, phase: String, attempts: Int = 1, before deadline: Date? = nil) throws {
        for attempt in 1...attempts {
            if let deadline, Date() >= deadline { throw DriverFailure.expected("a restriction before the fixture ends") }
            if try probeSafari(host, restricted: restricted, phase: phase, finalAttempt: attempt == attempts) { return }
            Thread.sleep(forTimeInterval: 2)
        }
    }

    private func probeSafari(_ host: String, restricted: Bool, phase: String, finalAttempt: Bool) throws -> Bool {
        let token = ProcessInfo.processInfo.environment["REDD_IOS_NAV_TOKEN"] ?? ""
        guard token.range(of: #"^[a-f0-9]{32}$"#, options: .regularExpression) != nil else {
            throw DriverFailure.expected("the host Safari navigation token")
        }
        let nonce = UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
        let url = "https://\(host)/?redd-ios-test=\(nonce)"
        let address = safari.buttons["Address"].firstMatch
        let previousTab = safari.state == .runningForeground && address.exists ? address.identifier : ""
        // The host uses CoreDevice to open the exact test URL. XCTest still
        // asserts the real Safari address and content before recording evidence.
        FileHandle.standardOutput.write(Data("REDD_IOS_NAV \(token) \(url)\n".utf8))
        guard safari.wait(for: .runningForeground, timeout: 25) else {
            throw DriverFailure.expected("Safari foregrounded by CoreDevice")
        }
        let restriction = safari.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@",
            "because it is restricted")).firstMatch
        let example = safari.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@",
            "This domain is for use in documentation examples")).firstMatch
        let hostDeadline = Date().addingTimeInterval(15)
        var ownedTab = ""
        repeat {
            let value = address.exists ? (address.value as? String ?? "") : ""
            let observedHost = value.components(separatedBy: .controlCharacters).joined()
            if observedHost == host && address.identifier != previousTab {
                ownedTab = address.identifier
                break
            }
            Thread.sleep(forTimeInterval: 0.25)
        } while Date() < hostDeadline
        guard !ownedTab.isEmpty else {
            try observe(safari, name: "\(phase) missing address")
            throw DriverFailure.expected("Safari to confirm navigation to \(host)")
        }
        defer {
            if ownedTab.hasPrefix("TabBarTab?isActive=true&UUID=") && address.exists && address.identifier == ownedTab {
                let close = address.buttons["CloseTabBarItemButton"]
                if close.isHittable { close.tap() }
            }
        }
        let expected = restricted ? restriction : example
        let opposite = restricted ? example : restriction
        guard expected.waitForExistence(timeout: finalAttempt ? 20 : 8) else {
            if !finalAttempt && !opposite.exists && safari.buttons["StopButton"].exists {
                try observe(safari, name: "\(phase) retry after Safari remained loading", includeTree: false)
                return false
            }
            try observe(safari, name: "\(phase) unexpected")
            throw DriverFailure.expected("\(host) to \(restricted ? "show Safari's native restriction" : "load Example Domain")")
        }
        guard expected.isHittable, !opposite.exists else { throw DriverFailure.expected("a single unambiguous Safari result for \(host)") }
        print("REDD_IOS_OBSERVATION \(ISO8601DateFormatter().string(from: Date())) \(phase) \(url)")
        try observe(safari, name: phase, includeTree: false)
        return true
    }

    private func removeOwnedFixture(name: String, after end: Date) throws {
        guard Date() >= end else { throw DriverFailure.expected("natural expiry before fixture cleanup") }
        blocker.activate()
        let turnOff = web.switches["Turn off \(name)"]
        if turnOff.exists {
            try tap(turnOff, named: "Turn off \(name)")
            let pauseTitle = web.staticTexts.matching(NSPredicate(format: "label BEGINSWITH[c] %@ AND label CONTAINS[c] %@",
                "Pause ", name)).firstMatch
            let stopTitle = web.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@",
                "Stop ", name)).firstMatch
            let usesPauseDialog = pauseTitle.waitForExistence(timeout: 3)
            let title = usesPauseDialog ? pauseTitle : stopTitle
            try require(title, "confirmation for the owned fixture")
            guard !web.textViews["Type here..."].exists,
                  !web.textFields.matching(NSPredicate(format: "placeholderValue == %@", "Type current word...")).firstMatch.exists else {
                throw DriverFailure.expected("the fixture to be outside its blocking window")
            }
            if usesPauseDialog {
                // Use the real duration control; Never leaves the user's
                // remembered timed choice unchanged and books no new restart.
                let label = web.staticTexts["Turn back on after"]
                try require(label, "the pause duration label")
                let controls = web.otherElements.matching(identifier: "Turn back on after")
                    .allElementsBoundByIndex.filter { $0.frame.minX > label.frame.maxX }
                guard controls.count == 1, let duration = controls.first else {
                    throw DriverFailure.expected("one owned pause duration control")
                }
                try tap(duration, named: "pause duration picker")
                let never = blocker.descendants(matching: .any).matching(NSPredicate(
                    format: "label == %@", "Never — keep turned off")).firstMatch
                try tap(never, named: "Never")
                try tap(web.buttons["Turn off \(name)"], named: "Turn off owned fixture")
            } else {
                try tap(web.buttons["Stop"], named: "Stop owned fixture")
            }
            guard title.waitForNonExistence(timeout: 15), !blocker.alerts.firstMatch.exists else {
                try observe(blocker, name: "Owned fixture stop failed", includeTree: false)
                throw DriverFailure.expected("the owned confirmation to close without an error")
            }
        }
        let offSwitch = web.switches["Turn on \(name)"]
        try require(offSwitch, "the owned fixture is off")
        // Calendar previews also expose the label, but only the list card
        // exposes the same name as both label and value.
        let card = web.staticTexts.matching(NSPredicate(format: "label == %@ AND value == %@", name, name)).firstMatch
        try require(card, "the owned fixture's card")
        // A foreground re-render can swallow the first card click. Retry
        // only the verified card and only until its exact editor is visible.
        let editor = web.textFields.matching(NSPredicate(format: "label == %@ AND value == %@", "NAME", name)).firstMatch
        for x in [0.5, 0.25, 0.75] where !editor.exists {
            card.coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.5)).tap()
            if editor.waitForExistence(timeout: 3) { break }
        }
        try require(editor, "the exact owned fixture editor")
        try tap(web.buttons["Delete"], named: "Delete owned fixture")
        guard offSwitch.waitForNonExistence(timeout: 10), !web.switches["Turn off \(name)"].exists else {
            throw DriverFailure.expected("the owned fixture to disappear after deletion")
        }
    }

    private func button(prefix: String) -> XCUIElement {
        web.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    private func dismissEditorDraft() {
        guard newSpaceTitle.exists else { return }
        let datePicker = blocker.datePickers.firstMatch
        if datePicker.exists && blocker.buttons["Done"].isHittable { blocker.buttons["Done"].tap() }
        let hideKeyboard = blocker.keyboards.buttons["Hide keyboard"]
        if hideKeyboard.exists { hideKeyboard.tap() }
        let cancel = web.buttons["Cancel"]
        for _ in 0..<2 where cancel.exists && !cancel.isHittable { web.swipeUp(velocity: .slow) }
        if cancel.isHittable { cancel.tap() }
    }

    private func enterWebKeys(_ text: String, into field: XCUIElement, named label: String) throws {
        try tap(field, named: label)
        let keyboard = blocker.keyboards.firstMatch
        if let existing = field.value as? String, !existing.isEmpty, existing != field.placeholderValue {
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.94, dy: 0.5)).tap()
            let delete = keyboard.keys["delete"]
            for _ in existing { try tap(delete, named: "keyboard delete") }
            guard (field.value as? String ?? "").isEmpty else {
                try observe(blocker, name: "Could not clear \(label)")
                throw DriverFailure.expected("an empty \(label) field before entry")
            }
        }
        for character in text {
            let key = keyboard.keys[character == " " ? "space" : String(character)]
            if !key.exists && character.isLetter && keyboard.keys["shift"].exists {
                keyboard.keys["shift"].firstMatch.tap()
            }
            if !key.exists && character.isNumber && keyboard.keys["numbers"].exists {
                keyboard.keys["numbers"].firstMatch.tap()
            }
            try tap(key, named: "keyboard key \(character)")
        }
        let hideKeyboard = keyboard.buttons["Hide keyboard"]
        if hideKeyboard.exists { hideKeyboard.tap() }
    }

    private func tap(_ element: XCUIElement, named name: String) throws {
        try require(element, name)
        guard element.isEnabled else { throw DriverFailure.expected("an enabled \(name)") }
        element.tap()
    }

    private func require(_ element: XCUIElement, _ name: String) throws {
        guard element.exists || element.waitForExistence(timeout: 10) else {
            try observe(blocker, name: "Missing \(name)")
            throw DriverFailure.expected(name)
        }
    }

    private func observe(_ element: XCUIElement, name: String, includeTree: Bool = true) throws {
        guard element.waitForExistence(timeout: 10) else { throw DriverFailure.expected(name) }
        let screen = XCTAttachment(screenshot: element.screenshot())
        screen.name = name
        screen.lifetime = .keepAlways
        add(screen)
        if includeTree {
            let tree = XCTAttachment(string: element.debugDescription)
            tree.name = "\(name) accessibility tree"
            tree.lifetime = .keepAlways
            add(tree)
        }
    }
}

enum DriverFailure: LocalizedError {
    case expected(String)

    var errorDescription: String? {
        switch self {
        case .expected(let observation): "Expected \(observation)."
        }
    }
}
