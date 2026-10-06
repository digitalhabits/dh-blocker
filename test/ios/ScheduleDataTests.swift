// Foundation-only tests for ScheduleBlockData's time rules, which the monitor
// extension enforces. Run by scripts/ci/test-ios-schedule-data.sh.
//
// What these protect: a start callback can arrive a moment before its minute;
// read then, the window looked unopened and the block was cleared with no retry.
// A start within the tolerance must be evaluated at the start; pauses and windows
// are unchanged.

import Foundation

@main
struct ScheduleDataTests {
    private static var failures = 0
    private static var checks = 0

    private static func check(_ condition: Bool, _ name: String) {
        checks += 1
        if !condition { failures += 1 }
        print("\(condition ? "ok  " : "FAIL") \(name)")
    }

    // 5 Oct 2026 is a Monday (Mon=0 in the stored day list).
    private static func at(_ hour: Int, _ minute: Int, _ second: Int = 0, ns: Int = 0, day: Int = 6) -> Date {
        Calendar.current.date(from: DateComponents(
            year: 2026, month: 10, day: day, hour: hour, minute: minute, second: second, nanosecond: ns
        ))!
    }

    private static func entry(
        _ start: (Int, Int)?, _ end: (Int, Int)?, days: [Int]? = nil, paused: Bool = false
    ) -> ScheduleBlockData {
        ScheduleBlockData(
            domains: [], appTokenData: ["app"], categoryTokenData: [], days: days,
            startHour: start?.0, startMinute: start?.1, endHour: end?.0, endMinute: end?.1,
            isPaused: paused ? true : nil
        )
    }

    private static func enforcesOnStart(_ entry: ScheduleBlockData, now: Date) -> Bool {
        entry.isActiveNow(now: entry.startCallbackEvaluationTime(now: now))
    }

    static func main() {
        let morning = entry((11, 0), (13, 0))
        check(enforcesOnStart(morning, now: at(10, 59, 59, ns: 800_000_000)), "start 0.2 s early enforces")
        check(enforcesOnStart(morning, now: at(10, 59, 51)), "start 9 s early enforces")
        check(enforcesOnStart(morning, now: at(10, 59, 50)), "start exactly at the tolerance enforces")
        check(!enforcesOnStart(morning, now: at(10, 59, 30)), "start 30 s early is left to the clock")
        check(enforcesOnStart(morning, now: at(11, 0, 1)), "start on time enforces")
        check(morning.startCallbackEvaluationTime(now: at(11, 0, 1)) == at(11, 0, 1),
              "on-time start is evaluated at the callback time")
        check(morning.startCallbackEvaluationTime(now: at(10, 59, 30)) == at(10, 59, 30),
              "out-of-tolerance start is evaluated at the callback time")
        check(enforcesOnStart(entry((0, 0), (6, 0)), now: at(23, 59, 55, day: 5)), "midnight start 5 s early enforces")
        check(!enforcesOnStart(entry((11, 0), (13, 0), paused: true), now: at(10, 59, 59)),
              "early start does not override a pause")
        check(entry(nil, nil).startCallbackEvaluationTime(now: at(10, 59, 59)) == at(10, 59, 59),
              "entry without a window is evaluated at the callback time")

        print("\(checks - failures)/\(checks) passed")
        if failures > 0 { exit(1) }
    }
}
