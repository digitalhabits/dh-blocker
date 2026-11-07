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

        try assertSafari(target, restricted: false, phase: "01 baseline target", attempts: 3)
        try assertSafari(control, restricted: false, phase: "02 baseline control", attempts: 3)
        blocker.activate()
        let previousSwitches = try focusSpaceSwitches()
        guard !web.staticTexts[name].exists else { throw DriverFailure.expected("a new, unique fixture name") }
        try createSchedule(name: name, start: start, end: end)
        try enableSchedule(name: name, start: start, end: end)
        try verifyScheduleAfterRelaunch(name)
        try observe(blocker, name: "03 owned schedule persisted across relaunch", includeTree: false)

        try assertSafari(target, restricted: true, phase: "04 target restricted", attempts: 3, before: end)
        try assertSafari(control, restricted: false, phase: "05 control still loads")
        guard Date() < end else { throw DriverFailure.expected("target and control observations before the fixture ends") }

        // Keep the device and Safari active around the real DeviceActivity
        // interval end. Blocker has been backgrounded since before the proof.
        try waitForExpiry(end)
        try assertSafari(target, restricted: false, phase: "06 target loads after expiry", attempts: 3)
        try assertSafari(control, restricted: false, phase: "07 control still loads after expiry")
        try removeOwnedFixture(name: name, after: end)
        guard try focusSpaceSwitches() == previousSwitches else {
            throw DriverFailure.expected("the previous focus spaces and their on/off states to remain unchanged")
        }
        try observe(blocker, name: "08 owned fixture removed", includeTree: false)
    }

    func testScheduledPauseLifecycle() throws {
        let (name, end) = try configuration()
        let calendar = Calendar.current
        let start = max(calendar.startOfDay(for: end), end.addingTimeInterval(-30 * 60))
        guard calendar.isDateInToday(end), start < Date(), end.timeIntervalSince(start) >= 15 * 60 else {
            throw DriverFailure.expected("an active fixture window of at least 15 minutes ending today")
        }

        try assertSafari(target, restricted: false, phase: "01 baseline target", attempts: 3)
        try assertSafari(control, restricted: false, phase: "02 baseline control", attempts: 3)
        blocker.activate()
        let previousSwitches = try focusSpaceSwitches()
        guard !web.staticTexts[name].exists, !web.buttons["Resume now"].exists else {
            throw DriverFailure.expected("a unique fixture name and no existing timed pause")
        }
        try createSchedule(name: name, start: start, end: end, pauseChallenge: true)
        try enableSchedule(name: name, start: start, end: end)
        try verifyScheduleAfterRelaunch(name)

        try assertSafari(target, restricted: true, phase: "03 target restricted", attempts: 3, before: end)
        try assertSafari(control, restricted: false, phase: "04 control allowed", before: end)
        blocker.activate()
        guard end.timeIntervalSinceNow > 6 * 60 else {
            throw DriverFailure.expected("enough time for the first pause to end during the schedule")
        }
        let duration = try openOwnedPause(name)
        let baseline = try XCTUnwrap(selectedTimedDuration(), "The initial remembered duration must be timed")
        journal("BREAK_BASELINE \(baseline)")
        let word = try enterFixtureChallenge()
        try chooseDuration("5 minutes", in: duration)
        XCTAssertEqual(challengeField().value as? String, word, "Selecting a duration preserves the typed challenge")
        try observe(blocker, name: "05 five-minute choice with the completed challenge", includeTree: false)
        journal("BREAK_CHANGE_REQUESTED")
        let first = try confirmTimedPause(name, duration: "5 minutes")
        try assertSafari(target, restricted: false, phase: "06 target allowed during pause", attempts: 3, before: first.earliestExpiry)
        try assertSafari(control, restricted: false, phase: "07 control allowed during pause", before: first.earliestExpiry)

        // Keep Safari foregrounded throughout the first pause. The app's
        // foreground reconciliation must not cause the restriction to return.
        try waitForExpiry(first.latestExpiry)
        guard blocker.state == .runningBackground || blocker.state == .runningBackgroundSuspended
                || blocker.state == .notRunning else {
            throw DriverFailure.expected("Blocker still out of the foreground at the native deadline")
        }
        try assertSafari(target, restricted: true, phase: "08 target reblocked before Blocker opens", attempts: 3, before: end)
        try assertSafari(control, restricted: false, phase: "09 control still allowed", before: end)

        blocker.terminate()
        blocker.activate()
        _ = try openOwnedPause(name)
        XCTAssertEqual(selectedTimedDuration(), "5 minutes", "The confirmed duration persists across relaunch")
        _ = try enterFixtureChallenge()
        let second = try confirmTimedPause(name, duration: "5 minutes")
        // Test durable pause state on a separate attempt so a foreground
        // reload cannot re-register the first attempt's DeviceActivity event.
        blocker.terminate()
        blocker.activate()
        try requireVisibleSwitch("Turn on \(name)")
        try observe(blocker, name: "10 paused fixture persisted across relaunch", includeTree: false)
        try assertSafari(target, restricted: false, phase: "11 second pause allows target after relaunch", attempts: 3,
            before: second.earliestExpiry)

        blocker.activate()
        try resumeOwned(name)
        try assertSafari(target, restricted: true, phase: "12 early resume reblocks target", attempts: 3,
            before: min(second.earliestExpiry, end))
        try assertSafari(control, restricted: false, phase: "13 control allowed after early resume", before: end)

        blocker.activate()
        let afterResume = try openOwnedPause(name)
        try confirmNever(name, in: afterResume, challenge: true)
        try assertSafari(target, restricted: false, phase: "14 Never turns off the owned fixture", attempts: 3, before: end)
        blocker.activate()
        try enableSchedule(name: name, start: start, end: end)
        let afterNever = try openOwnedPause(name)
        XCTAssertEqual(selectedTimedDuration(), "5 minutes", "Never preserves the last timed duration")
        try restoreDuration(baseline, name: name, in: afterNever)
        try deleteOffFixture(name)
        blocker.terminate()
        blocker.activate()
        try require(web.buttons["Block"], "Blocker focus space list after relaunch")
        guard !web.switches["Turn on \(name)"].exists, !web.switches["Turn off \(name)"].exists,
              try focusSpaceSwitches() == previousSwitches else {
            throw DriverFailure.expected("the owned fixture absent after relaunch and the previous switches unchanged")
        }
        try observe(blocker, name: "15 owned fixture removed and initial duration restored", includeTree: false)
    }

    private func verifyScheduleAfterRelaunch(_ name: String) throws {
        // A Screen Time rule can outlive unsaved WebView state. Load the app
        // again before accepting the schedule as saved.
        blocker.terminate()
        blocker.activate()
        try requireVisibleSwitch("Turn off \(name)")
    }

    private func requireVisibleSwitch(_ label: String) throws {
        try requireNoAlert()
        let toggle = web.switches[label]
        try require(toggle, label)
        try requireNoAlert()
        guard toggle.isHittable else { throw DriverFailure.expected("a visible \(label) switch") }
    }

    private func requireNoAlert() throws {
        let alert = blocker.alerts.firstMatch
        if alert.exists {
            let text = alert.staticTexts.allElementsBoundByIndex.map(\.label).joined(separator: " | ")
            try observe(blocker, name: "Unexpected Blocker alert", includeTree: false)
            throw DriverFailure.expected("no Blocker alert (observed: \(text))")
        }
    }

    private func requireClosed(_ element: XCUIElement, named name: String) throws {
        let deadline = Date().addingTimeInterval(15)
        repeat {
            try requireNoAlert()
            if !element.exists { return }
            Thread.sleep(forTimeInterval: 0.25)
        } while Date() < deadline
        try observe(blocker, name: "\(name) still open", includeTree: false)
        throw DriverFailure.expected("\(name) to close after confirmation")
    }

    private func ownedPauseTitle(_ name: String) -> XCUIElement {
        web.staticTexts.matching(NSPredicate(format: "label BEGINSWITH[c] %@ AND label CONTAINS[c] %@",
            "Pause ", name)).firstMatch
    }

    private func openOwnedPause(_ name: String) throws -> XCUIElement {
        try tap(web.switches["Turn off \(name)"], named: "Turn off \(name)")
        try require(ownedPauseTitle(name), "the owned fixture's pause dialog")
        return try pauseDurationControl()
    }

    private func pauseDurationControl() throws -> XCUIElement {
        let durationLabel = web.staticTexts["Turn back on after"]
        try require(durationLabel, "the pause duration label")
        // iPad WKWebView exposes the styled listbox trigger as an Other
        // alongside another Other containing the text label.
        let controls = web.otherElements.matching(identifier: "Turn back on after")
            .allElementsBoundByIndex.filter { $0.frame.minX > durationLabel.frame.maxX }
        guard controls.count == 1, let duration = controls.first else {
            try observe(blocker, name: "Pause duration controls")
            throw DriverFailure.expected("one pause duration control to the right of its label")
        }
        return duration
    }

    private func selectedTimedDuration() -> String? {
        let confirm = button(prefix: "Pause for ")
        return confirm.exists ? String(confirm.label.dropFirst("Pause for ".count)) : nil
    }

    private func chooseDuration(_ choice: String, in duration: XCUIElement) throws {
        try tap(duration, named: "pause duration picker")
        let option = blocker.descendants(matching: .any).matching(NSPredicate(format: "label == %@", choice)).firstMatch
        try require(option, "pause duration \(choice)")
        try tap(option, named: choice)
        if !choice.hasPrefix("Never") {
            XCTAssertEqual(selectedTimedDuration(), choice, "The duration picker selected the requested option")
        }
    }

    private func journal(_ event: String) {
        FileHandle.standardOutput.write(Data("REDD_IOS_\(event)\n".utf8))
    }

    private func confirmTimedPause(_ name: String, duration: String) throws
        -> (earliestExpiry: Date, latestExpiry: Date) {
        let started = Date()
        try submitOwnedPause(name, buttonLabel: "Pause for \(duration)")
        try requireVisibleSwitch("Turn on \(name)")
        _ = try ownedResume(name)
        let acknowledged = Date()
        guard acknowledged.timeIntervalSince(started) < 25 else { throw DriverFailure.expected("a prompt pause acknowledgement") }
        // Only the two five-minute checks consume this timing bracket. A
        // preference-restoring pause uses only the confirmation result.
        let earliest = started.addingTimeInterval(5 * 60)
        let latest = acknowledged.addingTimeInterval(5 * 60)
        if duration == "5 minutes" {
            print("REDD_IOS_PAUSE_ACK \(ISO8601DateFormatter().string(from: acknowledged)) expiry-by \(ISO8601DateFormatter().string(from: latest))")
        }
        try observe(blocker, name: "Timed pause confirmed without an alert", includeTree: false)
        return (earliest, latest)
    }

    private func submitOwnedPause(_ name: String, buttonLabel: String) throws {
        let title = ownedPauseTitle(name)
        try require(title, "the exact owned pause dialog")
        let confirm = web.buttons[buttonLabel]
        try require(confirm, buttonLabel)
        guard confirm.isEnabled, confirm.isHittable else { throw DriverFailure.expected("a hittable \(buttonLabel) button") }
        confirm.tap()
        if !title.waitForNonExistence(timeout: 5) {
            try requireNoAlert()
            // WKWebView can consume the first tap when focus returns from the
            // custom duration menu. Retry only the still-active owned dialog.
            if web.switches["Turn off \(name)"].exists, confirm.isEnabled, confirm.isHittable {
                confirm.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            }
        }
        try requireClosed(title, named: "Owned pause dialog")
    }

    private func ownedResume(_ name: String) throws -> XCUIElement {
        let toggle = web.switches["Turn on \(name)"]
        try requireVisibleSwitch("Turn on \(name)")
        let resumes = web.buttons.matching(identifier: "Resume now")
        try require(resumes.firstMatch, "Resume now on the paused fixture")
        // The resume control is below its card's switch. Reject an ambiguous
        // button or another card's button rather than resuming an existing rule.
        let resume = resumes.firstMatch
        let precedingSwitches = web.switches.matching(NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@",
            "Turn on ", "Turn off ")).allElementsBoundByIndex.filter { $0.frame.minY <= resume.frame.minY }
        guard resumes.count == 1, resume.isHittable,
              precedingSwitches.max(by: { $0.frame.minY < $1.frame.minY })?.label == toggle.label else {
            throw DriverFailure.expected("one visible Resume now control on the exact owned fixture")
        }
        return resume
    }

    private func resumeOwned(_ name: String) throws {
        try tap(ownedResume(name), named: "Resume now on the owned fixture")
        try requireVisibleSwitch("Turn off \(name)")
    }

    private func confirmNever(_ name: String, in duration: XCUIElement, challenge: Bool) throws {
        try chooseDuration("Never — keep turned off", in: duration)
        try require(web.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@",
            "This space will stay off until you turn it on again.")).firstMatch, "the Never explanation")
        if challenge { _ = try enterFixtureChallenge() }
        try submitOwnedPause(name, buttonLabel: "Turn off \(name)")
        try requireVisibleSwitch("Turn on \(name)")
        XCTAssertFalse(web.buttons["Resume now"].exists, "Never leaves no timed restart on the fixture")
    }

    private func restoreDuration(_ baseline: String, name: String, in duration: XCUIElement) throws {
        var selection = duration
        if selectedTimedDuration() != baseline {
            try chooseDuration(baseline, in: duration)
            if challengeField().exists { _ = try enterFixtureChallenge() }
            _ = try confirmTimedPause(name, duration: baseline)
            try resumeOwned(name)
            selection = try openOwnedPause(name)
            XCTAssertEqual(selectedTimedDuration(), baseline, "The initial timed duration has been restored")
        }
        journal("BREAK_RESTORED \(baseline)")
        try confirmNever(name, in: selection, challenge: challengeField().exists)
    }

    private func challengeField() -> XCUIElement {
        web.textFields.matching(NSPredicate(format: "placeholderValue == %@", "Type current word...")).firstMatch
    }

    private func enterFixtureChallenge() throws -> String {
        let field = challengeField()
        try require(field, "the one-word override challenge")
        let frame = field.frame
        let words = web.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "[a-z]{5}"))
            .allElementsBoundByIndex.filter {
                let word = $0.frame
                return word.maxY <= frame.minY + 2 && frame.minY - word.maxY < 80
                    && word.midX >= frame.minX && word.midX <= frame.maxX
            }
        guard words.count == 1, let word = words.first?.label else {
            try observe(blocker, name: "Could not locate exact visible challenge word")
            throw DriverFailure.expected("one visible five-letter challenge word immediately above the field")
        }
        try enterWebKeys(word, into: field, named: "current challenge word")
        XCTAssertEqual(field.value as? String, word, "The actual WKWebView challenge field contains the current word")
        return word
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
        try requireNoAlert()
        let startTitle = ownedStartTitle(name)
        if startTitle.exists {
            try tap(web.buttons["Cancel"], named: "Cancel the owned fixture's start confirmation")
            try requireClosed(startTitle, named: "Owned start confirmation")
        }
        let pauseTitle = ownedPauseTitle(name)
        if pauseTitle.exists {
            try tap(web.buttons["Cancel"], named: "Cancel the owned fixture's pause dialog")
            try requireClosed(pauseTitle, named: "Owned pause dialog")
        }
        try require(web.buttons["Block"], "Blocker focus space list")
        if let baseline = ProcessInfo.processInfo.environment["REDD_IOS_BREAK_TO_RESTORE"] {
            try recoverDuration(baseline, name: name, end: end)
        }
        if web.switches["Turn on \(name)"].exists {
            // An already off or paused fixture can be removed immediately.
            try deleteOffFixture(name)
        } else if web.switches["Turn off \(name)"].exists {
            guard Date() >= end else { throw DriverFailure.expected("the owned fixture's scheduled window to end") }
            try assertSafari(target, restricted: false, phase: "Recovery verifies expiry")
            try removeOwnedFixture(name: name, after: end)
        }
        try observe(blocker, name: "Owned fixture absent")
    }

    private func recoverDuration(_ baseline: String, name: String, end: Date) throws {
        if web.switches["Turn on \(name)"].exists {
            if web.buttons["Resume now"].exists {
                try resumeOwned(name)
            } else {
                let start = max(Calendar.current.startOfDay(for: end), end.addingTimeInterval(-30 * 60))
                try enableSchedule(name: name, start: start, end: end, recovering: true)
            }
        }
        let duration = try openOwnedPause(name)
        let current = selectedTimedDuration()
        guard current == baseline || current == "5 minutes" else {
            try tap(web.buttons["Cancel"], named: "Cancel without altering the new duration choice")
            journal("BREAK_EXTERNAL_CHOICE")
            return
        }
        try restoreDuration(baseline, name: name, in: duration)
    }

    private func focusSpaceSwitches() throws -> [String] {
        // Activating the app does not wait for its asynchronous data load. An
        // empty accessibility query before render is not an empty saved list.
        try require(web.buttons["Block"], "the focus-space list controls")
        let deadline = Date().addingTimeInterval(15)
        repeat {
            let switches = web.switches.matching(NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@",
                "Turn on ", "Turn off ")).allElementsBoundByIndex.map(\.label).sorted()
            if !switches.isEmpty || web.staticTexts["No focus spaces yet"].exists {
                return switches
            }
            Thread.sleep(forTimeInterval: 0.25)
        } while Date() < deadline
        throw DriverFailure.expected("a rendered focus-space list or its explicit empty state")
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

    private func createSchedule(name: String, start: Date, end: Date, pauseChallenge: Bool = false) throws {
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
            throw DriverFailure.expected("the intended window \(startValue)–\(endValue)")
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
        if pauseChallenge { try configureOneWordChallenge() }
        guard Date() < end.addingTimeInterval(-60) else { throw DriverFailure.expected("at least a minute remaining before Save") }
        try observe(blocker, name: "Owned schedule configuration", includeTree: false)
        print("REDD_IOS_FIXTURE_SAVE_REQUESTED \(name)")
        try tap(web.buttons["Save"], named: "Save")
        try requireClosed(newSpaceTitle, named: "Owned fixture editor")
        try require(web.staticTexts[name], name)
        print("REDD_IOS_FIXTURE_SAVED \(name)")
    }

    private func configureOneWordChallenge() throws {
        try tap(button(prefix: "To stop early"), named: "To stop early")
        let slider = web.sliders["How many words"]
        try require(slider, "the fixture's word count slider")
        // WKWebView's HTML slider has no usable native scrubber endpoints.
        guard slider.isHittable else { throw DriverFailure.expected("the visible fixture slider") }
        slider.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.5)).tap()
        try require(web.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "1 ·")).firstMatch,
            "the owned fixture has a one-word challenge")
    }

    private func ownedStartTitle(_ name: String) -> XCUIElement {
        web.staticTexts.matching(NSPredicate(format: "label BEGINSWITH[c] %@ AND label CONTAINS[c] %@",
            "Start ", name)).firstMatch
    }

    private func enableSchedule(name: String, start: Date, end: Date, recovering: Bool = false) throws {
        guard recovering || Date() < end.addingTimeInterval(-45) else { throw DriverFailure.expected("at least 45 seconds before the fixture ends") }
        try tap(web.switches["Turn on \(name)"], named: "Turn on \(name)")
        let title = ownedStartTitle(name)
        try require(title, "the owned fixture's start confirmation")
        try require(web.staticTexts[target], "the confirmation contains the fixture's target")
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm"
        let startValue = formatter.string(from: start)
        let endValue = formatter.string(from: end)
        try require(web.staticTexts.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@",
            startValue, endValue)).firstMatch, "the intended schedule in the start confirmation")
        try tap(web.buttons["Start"], named: "Start owned fixture")
        try requireClosed(title, named: "Owned start confirmation")
        try requireVisibleSwitch("Turn off \(name)")
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
            if try probeSafari(host, restricted: restricted, phase: phase, finalAttempt: attempt == attempts) {
                if let deadline, Date() >= deadline { throw DriverFailure.expected("the Safari observation before its deadline") }
                return
            }
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
        // Static text need not have a tappable activation point. Safari on
        // iPadOS 18 can throw from isHittable even for visible page text.
        let visibleDeadline = Date().addingTimeInterval(5)
        var visible = false
        repeat {
            if expected.exists {
                let frame = expected.frame
                let intersection = frame.intersection(safari.frame)
                visible = frame.origin.x.isFinite && frame.origin.y.isFinite
                    && frame.width.isFinite && frame.height.isFinite
                    && !intersection.isNull && !intersection.isEmpty
                if visible { break }
            }
            Thread.sleep(forTimeInterval: 0.25)
        } while Date() < visibleDeadline
        guard visible, !opposite.exists else { throw DriverFailure.expected("a single unambiguous visible Safari result for \(host)") }
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
                try confirmNever(name, in: pauseDurationControl(), challenge: false)
            } else {
                try tap(web.buttons["Stop"], named: "Stop owned fixture")
            }
            guard title.waitForNonExistence(timeout: 15), !blocker.alerts.firstMatch.exists else {
                try observe(blocker, name: "Owned fixture stop failed", includeTree: false)
                throw DriverFailure.expected("the owned confirmation to close without an error")
            }
        }
        try deleteOffFixture(name)
    }

    private func deleteOffFixture(_ name: String) throws {
        try requireNoAlert()
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
