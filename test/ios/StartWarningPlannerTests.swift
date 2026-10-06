// Foundation-only tests for the start-warning planner. Run by
// scripts/ci/test-ios-start-warnings.sh in several time zones, since the planner
// works on the phone's wall clock, as DeviceActivity does.

import Foundation

@main
struct StartWarningPlannerTests {
    private static var failures = 0
    private static var checks = 0

    private static func check(_ condition: Bool, _ name: String) {
        checks += 1
        if !condition { failures += 1 }
        print("\(condition ? "ok  " : "FAIL") \(name)")
    }

    private static let calendar = Calendar.current

    // 5 Oct 2026 is a Monday (Mon=0 in the stored day list).
    private static func at(_ day: Int, _ hour: Int, _ minute: Int, _ second: Int = 0, month: Int = 10, year: Int = 2026) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute, second: second))!
    }

    private static func ms(_ date: Date) -> Double { date.timeIntervalSince1970 * 1000 }

    private static let allDays = [0, 1, 2, 3, 4, 5, 6]

    private static func entry(
        _ space: String?, _ start: (Int, Int), _ end: (Int, Int), days: [Int]? = allDays,
        mode: String? = nil, paused: Bool = false, pauseEnd: Date? = nil,
        from: Date? = nil, until: Date? = nil, name: String? = nil, emoji: String? = nil
    ) -> ScheduleBlockData {
        ScheduleBlockData(
            domains: [], appTokenData: ["app"], categoryTokenData: [], days: days,
            startHour: start.0, startMinute: start.1, endHour: end.0, endMinute: end.1,
            activeFromTimestampMs: from.map(ms), activeUntilTimestampMs: until.map(ms),
            isPaused: paused ? true : nil, pauseEndTimestampMs: pauseEnd.map(ms),
            blocklistEmoji: emoji, blocklistName: name ?? space, mode: mode, blocklistId: space
        )
    }

    private static func config(
        enabled: Bool = true, manual: [ManualResumeWarning] = []
    ) -> StartWarningConfig {
        StartWarningConfig(
            enabled: enabled,
            locale: "en_GB",
            strings: StartWarningStrings(
                startTitleFmt: "{name} starts in 2 minutes",
                blockBodyFmt: "Block from {time}",
                allowBodyFmt: "Allow from {time}",
                resumeTitleFmt: "{name} is back on in 2 minutes",
                multiTitleFmt: "{count} focus spaces start in 2 minutes",
                multiBodyFmt: "{names} start at {time}",
                unnamedSpace: "Your focus space"
            ),
            manualResumes: manual,
            timeLocale: "en_GB"
        )
    }

    private static func plan(
        _ entries: [String: ScheduleBlockData], now: Date, manual: [ManualResumeWarning] = [], enabled: Bool = true
    ) -> [PlannedStartWarning] {
        StartWarningPlanner.plan(entries: entries, config: config(enabled: enabled, manual: manual), now: now)
    }

    private static func fires(_ warnings: [PlannedStartWarning], before end: Date) -> [Date] {
        warnings.map(\.fireDate).filter { $0 < end }
    }

    private static func wallClock(_ date: Date) -> (Int, Int) {
        (calendar.component(.hour, from: date), calendar.component(.minute, from: date))
    }

    static func main() {
        print("time zone: \(TimeZone.current.identifier)")
        let monday8 = at(5, 8, 0)

        // Basic start, cap and wall clock
        let daily = plan(["w-0": entry("work", (9, 0), (17, 0))], now: monday8)
        check(daily.count == startWarningCap, "daily space fills exactly the 64 slots")
        check(daily.first?.fireDate == at(5, 8, 58), "first warning is 2 minutes before today's start")
        check(daily.allSatisfy { $0.fireDate > monday8 }, "no warning is in the past")
        check(daily.allSatisfy { wallClock($0.fireDate) == (8, 58) }, "every warning stays at 08:58 on the wall clock, through clock changes")
        check(zip(daily, daily.dropFirst()).allSatisfy { $0.fireDate < $1.fireDate }, "warnings are sorted soonest first")
        check(daily.first?.title == "work starts in 2 minutes" && daily.first?.body == "Block from 09:00", "block wording with the start time")
        check(Set(daily.map(\.id)).count == daily.count && daily.allSatisfy { $0.id.hasPrefix(startWarningIdPrefix) },
              "ids are unique and carry the prefix")
        check(plan(["w-0": entry("work", (9, 0), (17, 0))], now: monday8) == daily, "same inputs give the same plan, so a rebuild changes nothing")

        let weekdays = plan(["w-0": entry("work", (9, 0), (17, 0), days: [0, 1, 2, 3, 4])], now: monday8)
        check(weekdays.count == startWarningCap, "weekday space fills the 64 slots")
        check(weekdays.allSatisfy { ![1, 7].contains(calendar.component(.weekday, from: $0.fireDate)) }, "weekday space never warns at weekends")
        let lastWeekday = weekdays.last.map { $0.fireDate.timeIntervalSince(monday8) / 86400 } ?? 0
        check(lastWeekday > 80 && lastWeekday < Double(startWarningHorizonDays), "64 weekday warnings reach about 12 weeks ahead")

        let monWed = plan(["w-0": entry("w", (9, 0), (10, 0), days: [0, 2])], now: at(4, 12, 0))
        check(fires(monWed, before: at(12, 0, 0)) == [at(5, 8, 58), at(7, 8, 58)], "Mon/Wed only, counted from a Sunday")

        // Never late
        check(plan(["w-0": entry("w", (9, 0), (17, 0))], now: at(5, 8, 59)).first?.fireDate == at(6, 8, 58),
              "after the warning time, today is skipped and tomorrow kept")
        check(plan(["w-0": entry("w", (9, 0), (17, 0))], now: at(5, 8, 57, 56)).first?.fireDate == at(6, 8, 58),
              "a warning due in under 5 s is dropped")
        check(plan(["w-0": entry("w", (9, 0), (17, 0))], now: at(5, 8, 57, 54)).first?.fireDate == at(5, 8, 58),
              "a warning due in 6 s is kept")
        check(plan(["w-0": entry("w", (9, 0), (17, 0))], now: at(5, 8, 58)).first?.fireDate == at(6, 8, 58),
              "exactly at the warning time counts as too late")

        // Allow mode and names
        let allow = plan(["d-0": entry("deep", (9, 0), (11, 0), mode: "allowlist", name: "Deep work", emoji: "🎯")], now: monday8)
        check(allow.first?.title == "🎯 Deep work starts in 2 minutes" && allow.first?.body == "Allow from 09:00",
              "allow space: emoji, name and allow wording")
        let unnamed = plan(["u-0": entry(nil, (9, 0), (10, 0), name: "")], now: monday8)
        check(unnamed.first?.title == "Your focus space starts in 2 minutes", "a space with no name gets the fallback")

        // Overnight and midnight
        let overnight = plan(["n-0": entry("night", (23, 0), (7, 0), days: [0])], now: monday8)
        check(fires(overnight, before: at(13, 0, 0)) == [at(5, 22, 58), at(12, 22, 58)], "overnight: 22:58 on its day, nothing at midnight")
        let pastMidnight = plan(["m-0": entry("m", (0, 1), (6, 0), days: [1])], now: monday8)
        check(pastMidnight.first?.fireDate == at(5, 23, 59), "a Tuesday 00:01 start warns at 23:59 on Monday")
        let mondayMidnight = plan(["m-0": entry("m", (0, 0), (6, 0), days: [0])], now: at(4, 12, 0))
        check(mondayMidnight.first?.fireDate == at(4, 23, 58), "a Monday 00:00 start warns at 23:58 on Sunday")

        // All day (equal times)
        check(plan(["a-0": entry("a", (0, 0), (0, 0))], now: monday8).isEmpty, "24/7 every day is never warned once running")
        let weekend = plan(["a-0": entry("a", (0, 0), (0, 0), days: [5, 6])], now: monday8)
        check(fires(weekend, before: at(12, 0, 0)) == [at(9, 23, 58)], "weekend all day: one warning Friday 23:58, none Saturday night")
        let nineToNine = plan(["a-0": entry("a", (9, 0), (9, 0), days: [0, 1])], now: at(4, 12, 0))
        check(fires(nineToNine, before: at(11, 0, 0)) == [at(5, 8, 58)],
              "all day at 09:00 warns at its own time, once for back-to-back days")

        // Same space carrying on, and different spaces
        let touching = plan(["w-0": entry("work", (9, 0), (12, 0)), "w-1": entry("work", (12, 0), (17, 0))], now: monday8)
        check(fires(touching, before: at(6, 0, 0)) == [at(5, 8, 58)], "touching segments of one space: no warning at 11:58")
        let handover = plan(["a-0": entry("morning", (9, 0), (12, 0)), "b-0": entry("afternoon", (12, 0), (17, 0))], now: monday8)
        check(fires(handover, before: at(6, 0, 0)) == [at(5, 8, 58), at(5, 11, 58)], "space B starting as A ends is warned")
        let blockToAllow = plan(["a-0": entry("block", (9, 0), (12, 0)), "b-0": entry("allow", (12, 0), (17, 0), mode: "allowlist")], now: monday8)
        check(blockToAllow.first { $0.fireDate == at(5, 11, 58) }?.body == "Allow from 12:00", "block to allow switch is warned with allow wording")
        let overlapping = plan(["a-0": entry("long", (8, 0), (18, 0)), "b-0": entry("short", (12, 0), (13, 0))], now: at(5, 7, 0))
        check(fires(overlapping, before: at(6, 0, 0)) == [at(5, 7, 58), at(5, 11, 58)], "a second space starting inside another is still warned")
        let sameMinute = plan(["a-0": entry("work", (9, 0), (12, 0)), "b-0": entry("reading", (9, 0), (10, 0))], now: monday8)
        check(sameMinute.first?.title == "2 focus spaces start in 2 minutes" && sameMinute.first?.body == "reading and work start at 09:00",
              "two spaces at the same minute make one notification")
        check(fires(sameMinute, before: at(6, 0, 0)).count == 1, "the combined notification is the only one that morning")

        // Pause and resume
        let pausedToWed = plan(["w-0": entry("work", (9, 0), (17, 0), paused: true, pauseEnd: at(7, 10, 0))], now: monday8)
        let pausedFires = fires(pausedToWed, before: at(9, 0, 0))
        check(pausedFires == [at(7, 9, 58), at(8, 8, 58)], "a pause skips covered starts and warns before it ends")
        check(pausedToWed.first?.title == "work is back on in 2 minutes" && pausedToWed.first?.body == "Block from 10:00", "resume wording, with what the space does")
        check(plan(["w-0": entry("work", (9, 0), (17, 0), paused: true)], now: monday8).isEmpty, "off with no end time: nothing")
        let pauseEndsOutside = plan(["w-0": entry("work", (9, 0), (17, 0), paused: true, pauseEnd: at(5, 20, 0))], now: monday8)
        check(pauseEndsOutside.first?.fireDate == at(6, 8, 58), "a pause ending outside the window gets no resume warning")
        let pauseEndsAtStart = plan(["w-0": entry("work", (9, 0), (17, 0), paused: true, pauseEnd: at(6, 9, 0))], now: monday8)
        check(fires(pauseEndsAtStart, before: at(7, 0, 0)) == [at(6, 8, 58)] && pauseEndsAtStart.first?.title == "work is back on in 2 minutes",
              "a pause ending at a start gives one warning, with resume wording")
        let shortPause = plan(["w-0": entry("work", (7, 0), (17, 0), paused: true, pauseEnd: at(5, 8, 1))], now: monday8)
        check(shortPause.first?.fireDate == at(6, 6, 58), "a pause ending within 2 minutes gets no warning")
        let fiveMinutePause = plan(["w-0": entry("work", (7, 0), (17, 0), paused: true, pauseEnd: at(5, 8, 5))], now: monday8)
        check(fiveMinutePause.first?.fireDate == at(5, 8, 3), "a 5-minute pause still warns 2 minutes before it ends")
        // isActiveNow treats a broken pause end as no pause, so blocking runs and so do warnings.
        check(plan(["w-0": entry("work", (9, 0), (17, 0), paused: true, pauseEnd: Date(timeIntervalSince1970: .nan))], now: monday8)
                .first?.fireDate == at(5, 8, 58),
              "a broken pause time is ignored, as blocking ignores it")

        let manual = [ManualResumeWarning(id: "b1", name: "Phone", emoji: "📵", mode: nil, resumeAtMs: ms(at(6, 8, 0)))]
        let manualPlan = plan([:], now: monday8, manual: manual)
        check(manualPlan.count == 1 && manualPlan.first?.fireDate == at(6, 7, 58), "manual block stopped for 24 h: one warning before it resumes")
        check(manualPlan.first?.title == "📵 Phone is back on in 2 minutes", "manual resume uses resume wording")
        let allowResume = plan([:], now: monday8, manual: [ManualResumeWarning(id: "b2", name: "Study", emoji: nil, mode: "allowlist", resumeAtMs: ms(at(6, 8, 0)))])
        check(allowResume.first?.body == "Allow from 08:00", "an allow space coming back says only allowed apps open")
        check(plan([:], now: monday8, manual: [ManualResumeWarning(id: "b1", name: nil, emoji: nil, mode: nil, resumeAtMs: ms(at(5, 8, 1)))]).isEmpty,
              "manual resume within 2 minutes: nothing")
        check(plan([:], now: monday8, manual: [ManualResumeWarning(id: "b1", name: nil, emoji: nil, mode: nil, resumeAtMs: .infinity)]).isEmpty,
              "a broken manual resume time adds no warning")

        // Date range and one-off
        let oneOff = plan(["o-0-0": entry("trip", (14, 0), (15, 0), days: nil, from: at(7, 14, 0), until: at(7, 15, 0))], now: monday8)
        check(oneOff.map(\.fireDate) == [at(7, 13, 58)], "a one-off space warns exactly once")
        let ranged = plan(["r-0": entry("r", (9, 0), (10, 0), from: at(7, 0, 0), until: at(9, 23, 59))], now: monday8)
        check(ranged.map(\.fireDate) == [at(7, 8, 58), at(8, 8, 58), at(9, 8, 58)], "a date-limited space warns only inside its dates")

        // Cap, disabled, empty
        var many: [String: ScheduleBlockData] = [:]
        for i in 0..<20 { many["s\(i)-0"] = entry("s\(i)", (9, i), (9, i + 30)) }
        let capped = plan(many, now: monday8)
        check(capped.count == startWarningCap && capped.first?.fireDate == at(5, 8, 58) && capped.last?.fireDate == at(8, 9, 1),
              "20 daily spaces: exactly 64, the soonest kept")
        check(plan(["w-0": entry("w", (9, 0), (17, 0))], now: monday8, enabled: false).isEmpty, "switched off: nothing")
        check(plan([:], now: monday8).isEmpty, "no spaces: nothing")

        // Clock changes, checked where they happen
        if TimeZone.current.identifier == "America/New_York" {
            // Clocks go back at 02:00 on 1 Nov 2026, so 01:30 happens twice.
            let repeated = plan(["n-0": entry("n", (1, 30), (3, 0))], now: at(31, 12, 0))
            check(fires(repeated, before: at(2, 0, 0, month: 11)).count == 1, "clocks back: a repeated 01:30 warns once")
            // Clocks go forward at 02:00 on 14 Mar 2027, so 02:30 never happens.
            let missing = plan(["n-0": entry("n", (2, 30), (4, 0))], now: at(13, 12, 0, month: 3, year: 2027))
            let day = missing.filter { calendar.isDate($0.fireDate, inSameDayAs: at(14, 0, 0, month: 3, year: 2027)) }
            check(day.count == 1, "clocks forward: a missing 02:30 still gets one warning that day")
        }
        if TimeZone.current.identifier == "Europe/London" {
            // Clocks go back at 02:00 on 25 Oct 2026; a 09:00 start is unaffected.
            let around = plan(["w-0": entry("w", (9, 0), (17, 0))], now: at(24, 12, 0))
            check(around.prefix(3).map(\.fireDate) == [at(25, 8, 58), at(26, 8, 58), at(27, 8, 58)], "clocks back: 08:58 every day")
        }

        print("\(checks - failures)/\(checks) passed")
        if failures > 0 { exit(1) }
    }
}
