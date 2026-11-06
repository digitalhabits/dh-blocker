// Foundation-only tests for when the app leaves a DeviceActivity registration
// alone. Run by scripts/ci/test-ios-schedule-registration.sh — no simulator.
//
// What these protect: replacing a registration shortly before its window starts
// was seen never to fire that start, and the app re-registers on every launch.
// An unchanged registration starting within the quiet period must be left alone;
// anything new, changed or further away must still be registered.

import Foundation

@main
struct ScheduleRegistrationTests {
    private static var failures = 0
    private static var checks = 0

    private static func check(_ condition: Bool, _ name: String) {
        checks += 1
        if condition {
            print("ok   \(name)")
        } else {
            failures += 1
            print("FAIL \(name)")
        }
    }

    private static func window(
        _ startHour: Int, _ startMinute: Int, _ endHour: Int, _ endMinute: Int,
        repeats: Bool = true, warning: Int? = nil
    ) -> ScheduleWindowSignature {
        ScheduleWindowSignature(
            intervalStart: DateComponents(hour: startHour, minute: startMinute),
            intervalEnd: DateComponents(hour: endHour, minute: endMinute),
            repeats: repeats,
            warningTime: warning.map { DateComponents(minute: $0) }
        )
    }

    private static func minute(_ hour: Int, _ minute: Int) -> Int { hour * 60 + minute }

    static func main() {
        let desired = window(15, 23, 16, 0)

        check(
            leaveRegistrationAlone(held: desired, desired: desired, nowMinuteOfDay: minute(15, 22)),
            "an unchanged registration starting next minute is left alone"
        )
        check(
            leaveRegistrationAlone(held: desired, desired: desired, nowMinuteOfDay: minute(15, 23)),
            "an unchanged registration starting this minute is left alone"
        )
        check(
            !leaveRegistrationAlone(held: desired, desired: desired, nowMinuteOfDay: minute(14, 53)),
            "an unchanged registration starting in 30 min is re-registered as before"
        )
        check(
            !leaveRegistrationAlone(held: desired, desired: desired, nowMinuteOfDay: minute(15, 24)),
            "a window that started a minute ago is not treated as about to start"
        )
        check(
            !leaveRegistrationAlone(held: nil, desired: desired, nowMinuteOfDay: minute(15, 22)),
            "a registration the system does not hold is always registered"
        )
        check(
            !leaveRegistrationAlone(held: window(15, 24, 16, 0), desired: desired, nowMinuteOfDay: minute(15, 22)),
            "a changed start time is always re-registered"
        )
        check(
            !leaveRegistrationAlone(held: window(15, 23, 16, 30), desired: desired, nowMinuteOfDay: minute(15, 22)),
            "a changed end time is always re-registered"
        )
        check(
            !leaveRegistrationAlone(held: window(15, 23, 16, 0, repeats: false), desired: desired, nowMinuteOfDay: minute(15, 22)),
            "a changed repeat setting is always re-registered"
        )
        check(
            !leaveRegistrationAlone(held: window(15, 23, 15, 38, warning: 5), desired: window(15, 23, 15, 38), nowMinuteOfDay: minute(15, 22)),
            "a changed warning offset is always re-registered"
        )

        // The system may hand back components carrying fields we never set; those
        // must not make an unchanged registration look changed.
        var heldStart = DateComponents(hour: 15, minute: 23)
        heldStart.second = 0
        heldStart.calendar = Calendar(identifier: .gregorian)
        heldStart.timeZone = TimeZone(identifier: "Europe/London")
        let heldWithExtras = ScheduleWindowSignature(
            intervalStart: heldStart,
            intervalEnd: DateComponents(hour: 16, minute: 0),
            repeats: true,
            warningTime: nil
        )
        check(
            leaveRegistrationAlone(held: heldWithExtras, desired: desired, nowMinuteOfDay: minute(15, 22)),
            "extra fields on the held registration do not count as a change"
        )

        let heldWithoutHour = ScheduleWindowSignature(
            intervalStart: DateComponents(minute: 23),
            intervalEnd: DateComponents(hour: 16, minute: 0),
            repeats: true,
            warningTime: nil
        )
        check(
            !leaveRegistrationAlone(held: heldWithoutHour, desired: desired, nowMinuteOfDay: minute(15, 22)),
            "a held registration with an unreadable time is replaced, not trusted"
        )

        let afterMidnight = window(0, 1, 1, 0)
        check(
            leaveRegistrationAlone(held: afterMidnight, desired: afterMidnight, nowMinuteOfDay: minute(23, 58)),
            "a start just after midnight counts as imminent from just before it"
        )

        print("\n\(checks - failures)/\(checks) passed")
        exit(failures == 0 ? 0 : 1)
    }
}
