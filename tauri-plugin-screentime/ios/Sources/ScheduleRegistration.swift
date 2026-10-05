import Foundation

/// The parts of a DeviceActivity registration that decide when it fires. Everything
/// a callback acts on is read from the App Group when it fires, so two registrations
/// with equal signatures behave identically. Foundation-only so it runs in a plain
/// Swift test on the host.
struct ScheduleWindowSignature: Equatable {
    let startHour: Int?
    let startMinute: Int?
    let endHour: Int?
    let endMinute: Int?
    let repeats: Bool
    let warningMinutes: Int?

    /// Reads hour and minute only: the system may hand a registration back with
    /// fields we never set (calendar, time zone, a zero second), and those must not
    /// make an unchanged registration look changed.
    init(intervalStart: DateComponents, intervalEnd: DateComponents, repeats: Bool, warningTime: DateComponents?) {
        startHour = intervalStart.hour
        startMinute = intervalStart.minute
        endHour = intervalEnd.hour
        endMinute = intervalEnd.minute
        self.repeats = repeats
        warningMinutes = warningTime?.minute
    }

    var hasCompleteWindow: Bool {
        startHour != nil && startMinute != nil && endHour != nil && endMinute != nil
    }
}

/// How close to its start an unchanged registration is left alone. Replacing a
/// registration restarts it, and one replaced in the minute before its start was
/// seen never to fire that start, while one made 2.5 minutes ahead fired (App Store
/// build, iOS 26.5.2, 2 Oct 2026).
let registrationQuietMinutes = 5

/// Whether the app should skip re-registering a schedule it is about to register.
/// Only an identical registration starting within the quiet period is skipped.
/// Outside it the app keeps re-registering on every launch as before, because
/// reopening the app is also how a registration the system stopped honouring is
/// restored — so that path is deliberately left intact.
func leaveRegistrationAlone(
    held: ScheduleWindowSignature?,
    desired: ScheduleWindowSignature,
    nowMinuteOfDay: Int
) -> Bool {
    guard let held = held, held.hasCompleteWindow, desired.hasCompleteWindow, held == desired,
          let startHour = desired.startHour, let startMinute = desired.startMinute else {
        return false
    }
    let minutesUntilStart = (startHour * 60 + startMinute - nowMinuteOfDay + 24 * 60) % (24 * 60)
    return minutesUntilStart < registrationQuietMinutes
}
