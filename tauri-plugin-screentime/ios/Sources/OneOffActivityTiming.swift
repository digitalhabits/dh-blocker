import Foundation

/// Resolves one-off Screen Time deadlines before constructing a calendar schedule.
struct OneOffActivityTiming {
    static let activityDuration: TimeInterval = 15 * 60
    /// Policy for the resolved interval: accept at most one second late, but
    /// never accept an interval before the rounded deadline.
    static let resolvedIntervalTolerance: TimeInterval = 1

    let startDate: Date
    let endDate: Date
    let intervalStart: DateComponents
    let intervalEnd: DateComponents

    static func resolve(
        startTimestampMs: Double,
        now: Date = Date(),
        calendar: Calendar = .current
    ) throws -> OneOffActivityTiming {
        let requestedSeconds = startTimestampMs / 1000
        guard startTimestampMs.isFinite, requestedSeconds.isFinite else {
            throw OneOffActivityTimingError.invalidDeadline
        }

        let nowSeconds = now.timeIntervalSince1970
        let roundedSeconds = ceil(requestedSeconds)
        let latestStart = Date.distantFuture.timeIntervalSince1970 - activityDuration
        guard nowSeconds.isFinite, roundedSeconds.isFinite,
              requestedSeconds > nowSeconds,
              roundedSeconds > nowSeconds,
              roundedSeconds <= latestStart else {
            throw OneOffActivityTimingError.deadlineNotInFuture
        }

        let startDate = Date(timeIntervalSince1970: roundedSeconds)
        let endDate = Date(timeIntervalSince1970: roundedSeconds + activityDuration)
        guard endDate.timeIntervalSince1970.isFinite else {
            throw OneOffActivityTimingError.invalidDeadline
        }

        // Preserve the established time-only registration for an ordinary
        // same-day activity. A later-day deadline, or an activity crossing
        // midnight, must carry its date or DeviceActivity can choose today's
        // occurrence instead.
        let crossesMidnight = !calendar.isDate(startDate, inSameDayAs: endDate)
        let usesFullDateComponents = !calendar.isDate(startDate, inSameDayAs: now) || crossesMidnight
        let components: Set<Calendar.Component> = usesFullDateComponents
            ? [.year, .month, .day, .hour, .minute, .second]
            : [.hour, .minute, .second]

        guard let resolvedStart = calendar.date(from: calendar.dateComponents(components, from: startDate)),
              let resolvedEnd = calendar.date(from: calendar.dateComponents(components, from: endDate)),
              resolvedStart.timeIntervalSince1970.isFinite,
              resolvedEnd.timeIntervalSince1970.isFinite else {
            throw OneOffActivityTimingError.invalidCalendarComponents
        }

        return OneOffActivityTiming(
            startDate: startDate,
            endDate: endDate,
            intervalStart: calendar.dateComponents(components, from: startDate),
            intervalEnd: calendar.dateComponents(components, from: endDate)
        )
    }

    /// Validate `DeviceActivitySchedule.nextInterval` before replacing an
    /// existing monitor. A nil interval, an interval on another calendar day,
    /// or a materially early/late boundary is unsafe. Only the one-second
    /// rounding tolerance above is accepted.
    func isResolvedIntervalSafe(
        _ interval: DateInterval?,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> Bool {
        guard let interval,
              interval.start.timeIntervalSince1970.isFinite,
              interval.end.timeIntervalSince1970.isFinite,
              interval.start <= interval.end,
              interval.start > now,
              calendar.isDate(interval.start, inSameDayAs: startDate),
              interval.start >= startDate,
              interval.start.timeIntervalSince(startDate) <= Self.resolvedIntervalTolerance,
              abs(interval.end.timeIntervalSince(endDate)) <= Self.resolvedIntervalTolerance else {
            return false
        }
        return true
    }
}

enum OneOffActivityTimingError: Error, CustomStringConvertible {
    case invalidDeadline
    case deadlineNotInFuture
    case invalidCalendarComponents

    public var description: String {
        switch self {
        case .invalidDeadline:
            return "Invalid one-off activity deadline"
        case .deadlineNotInFuture:
            return "One-off activity deadline is not in the future"
        case .invalidCalendarComponents:
            return "Could not resolve one-off activity calendar components"
        }
    }
}
