import Foundation

private func fail(_ message: String) -> Never { fatalError("FAIL: \(message)") }

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { fail(message) }
}

private func expectThrows(_ message: String, _ body: () throws -> Void) {
    do {
        try body()
        fail(message)
    } catch {
        // Expected.
    }
}

private var calendar: Calendar = {
    var value = Calendar(identifier: .gregorian)
    value.timeZone = TimeZone(secondsFromGMT: 0)!
    return value
}()

private func date(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int, _ second: Int, _ nanosecond: Int = 0) -> Date {
    calendar.date(from: DateComponents(
        calendar: calendar,
        timeZone: calendar.timeZone,
        year: year,
        month: month,
        day: day,
        hour: hour,
        minute: minute,
        second: second,
        nanosecond: nanosecond
    ))!
}

private final class DroppingUserDefaults: UserDefaults {
    override func set(_ value: Any?, forKey defaultName: String) {}
}

@main
struct OneOffActivityTimingTests {
    static func main() throws {
        let now = date(2026, 9, 25, 10, 0, 0, 250_000_000)

        do {
            let timing = try OneOffActivityTiming.resolve(
                startTimestampMs: date(2026, 9, 25, 10, 10, 0, 250_000_000).timeIntervalSince1970 * 1000,
                now: now,
                calendar: calendar
            )
            expect(timing.startDate == date(2026, 9, 25, 10, 10, 1), "fractional deadlines round up to the next whole second")
            expect(timing.intervalStart.year == nil && timing.intervalStart.day == nil, "same-day timing keeps time-only components")
            expect(timing.intervalStart.second == 1, "same-day timing retains the rounded second")
        }

        do {
            let timing = try OneOffActivityTiming.resolve(
                startTimestampMs: date(2026, 9, 25, 10, 5, 0, 750_000_000).timeIntervalSince1970 * 1000,
                now: now,
                calendar: calendar
            )
            expect(timing.startDate == date(2026, 9, 25, 10, 5, 1), "five-minute deadline is rounded up")
            expect(timing.endDate == date(2026, 9, 25, 10, 20, 1), "five-minute activity keeps its fifteen-minute duration")
        }

        do {
            let timestampMs = date(2026, 9, 26, 10, 0, 0, 1).timeIntervalSince1970 * 1000
            let timing = try OneOffActivityTiming.resolve(
                startTimestampMs: timestampMs,
                now: now,
                calendar: calendar
            )
            expect(timing.startDate == Date(timeIntervalSince1970: ceil(timestampMs / 1000)), "next-day deadline is rounded up")
            expect(timing.intervalStart.year == 2026 && timing.intervalStart.month == 9 && timing.intervalStart.day == 26,
                   "next-day timing includes the full calendar date")
            expect(timing.intervalEnd.year == 2026 && timing.intervalEnd.day == 26,
                   "next-day same-day end keeps the full calendar date")
        }

        do {
            let timing = try OneOffActivityTiming.resolve(
                startTimestampMs: date(2026, 9, 25, 23, 50, 0, 1).timeIntervalSince1970 * 1000,
                now: now,
                calendar: calendar
            )
            expect(timing.intervalStart.year == 2026 && timing.intervalStart.day == 25,
                   "midnight-crossing start includes the full calendar date")
            expect(timing.intervalEnd.year == 2026 && timing.intervalEnd.day == 26,
                   "midnight-crossing end includes the full calendar date")
        }

        expectThrows("NaN deadline is rejected") {
            _ = try OneOffActivityTiming.resolve(startTimestampMs: .nan, now: now, calendar: calendar)
        }
        expectThrows("infinite deadline is rejected") {
            _ = try OneOffActivityTiming.resolve(startTimestampMs: .infinity, now: now, calendar: calendar)
        }
        expectThrows("past deadline is rejected") {
            _ = try OneOffActivityTiming.resolve(
                startTimestampMs: date(2026, 9, 25, 9, 59, 59).timeIntervalSince1970 * 1000,
                now: now,
                calendar: calendar
            )
        }
        expectThrows("a deadline already in progress is rejected before rounding") {
            _ = try OneOffActivityTiming.resolve(
                startTimestampMs: date(2026, 9, 25, 10, 0, 0, 150_000_000).timeIntervalSince1970 * 1000,
                now: now,
                calendar: calendar
            )
        }

        do {
            let timing = try OneOffActivityTiming.resolve(
                startTimestampMs: date(2026, 9, 25, 10, 10, 0).timeIntervalSince1970 * 1000,
                now: now,
                calendar: calendar
            )
            expect(timing.isResolvedIntervalSafe(
                DateInterval(start: timing.startDate.addingTimeInterval(-30), duration: 900),
                now: now,
                calendar: calendar
            ) == false, "an early resolved interval is rejected")
            expect(timing.isResolvedIntervalSafe(nil, now: now, calendar: calendar) == false,
                   "a missing resolved interval is rejected")
            let wrongDay = DateInterval(start: timing.startDate.addingTimeInterval(24 * 3600), duration: 900)
            expect(timing.isResolvedIntervalSafe(wrongDay, now: now, calendar: calendar) == false,
                   "a resolved interval on another day is rejected")
            let earlyByHalfSecond = DateInterval(start: timing.startDate.addingTimeInterval(-0.5), duration: 900)
            expect(timing.isResolvedIntervalSafe(earlyByHalfSecond, now: now, calendar: calendar) == false,
                   "an interval before the rounded deadline is rejected")
            let lateByHalfSecond = DateInterval(start: timing.startDate.addingTimeInterval(0.5), duration: 900)
            expect(timing.isResolvedIntervalSafe(lateByHalfSecond, now: now, calendar: calendar),
                   "sub-second late scheduling tolerance is accepted")
        }

        let payloadData = Data("resume".utf8)
        expect(!CheckedUserDefaultsWrite.write(payloadData, key: "payload", defaults: nil),
               "missing shared defaults report a failed persistence write")
        expect(!CheckedUserDefaultsWrite.write(payloadData, key: "payload", defaults: DroppingUserDefaults()),
               "a write that cannot be read back reports a failed persistence write")
        let suiteName = "OneOffActivityTimingTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        expect(CheckedUserDefaultsWrite.write(payloadData, key: "payload", defaults: defaults),
               "verified UserDefaults writes succeed")
        expect(defaults.data(forKey: "payload") == payloadData,
               "verified UserDefaults writes are readable")
        defaults.removePersistentDomain(forName: suiteName)

        let invalidPayload = ScheduleBlockData(
            domains: [], appTokenData: [], categoryTokenData: [], days: nil,
            pauseEndTimestampMs: .nan
        )
        expect(!SharedManualBlockStore.saveResumePayload(blockId: "nan", invalidPayload),
               "resume payload encoding failure is reported")
        expect(!SharedManualBlockStore.saveManualBlockState(invalidPayload),
               "manual block state encoding failure is reported")
        expect(!SharedManualBlockStore.saveManualAllowlistState(invalidPayload),
               "manual allowlist state encoding failure is reported")

        var didReapply = false
        var didRemove = false
        expect(!ManualResumePayloadCommit.commit(
            save: { false },
            reapply: { didReapply = true },
            remove: { didRemove = true }
        ), "failed resume commits are reported")
        expect(!didReapply && !didRemove, "failed resume commits retain their payload")
        expect(ManualResumePayloadCommit.commit(
            save: { true },
            reapply: { didReapply = true },
            remove: { didRemove = true }
        ), "successful resume commits are reported")
        expect(didReapply && didRemove, "successful resume commits reapply and consume their payload")

        print("OneOffActivityTimingTests: OK")
    }
}
