import Foundation
#if os(iOS) && canImport(UserNotifications)
import UserNotifications
#endif

// Notifications 2 minutes before a focus space starts or comes back from a pause.
// The planner is Foundation-only so a plain Swift test can run it on the host.
// Every failure here means a missing warning; nothing in this file touches blocking.

let startWarningLeadSeconds: TimeInterval = 120
let startWarningIdPrefix = "redd-start-warning-"
/// iOS keeps the 64 soonest pending notifications per app and drops the rest.
let startWarningCap = 64
/// A loop bound only: 64 warnings fill up long before this for any real schedule.
let startWarningHorizonDays = 90

struct StartWarningStrings: Decodable {
    let startTitleFmt: String
    let blockBodyFmt: String
    let allowBodyFmt: String
    let resumeTitleFmt: String
    let multiTitleFmt: String
    let multiBodyFmt: String
    let unnamedSpace: String
}

/// A manual focus space stopped for a set time. Swift keeps no time or name for
/// these, so the app sends them.
struct ManualResumeWarning: Decodable {
    let id: String
    let name: String?
    let emoji: String?
    let mode: String?
    let resumeAtMs: Double
}

struct StartWarningConfig: Decodable {
    let enabled: Bool
    let locale: String
    let strings: StartWarningStrings
    let manualResumes: [ManualResumeWarning]?
    /// Tests only. The app leaves it out, so times follow the phone's own 12/24-hour setting.
    let timeLocale: String?
}

struct PlannedStartWarning: Equatable {
    let id: String
    let fireDate: Date
    let title: String
    let body: String
}

extension ScheduleBlockData {
    /// Whether DeviceActivity enforces this entry at `t`: isActiveNow, except that an
    /// equal-times segment runs for 24 hours from its own time, while isActiveNow
    /// reads it from midnight (plan follow-up F2). At 00:00 the two agree.
    func enforcedForStartWarning(at t: Date) -> Bool {
        guard let startHour, let startMinute, startHour == endHour, startMinute == endMinute,
              startHour * 60 + startMinute > 0 else { return isActiveNow(now: t) }
        let dayless = ScheduleBlockData(
            domains: domains, appTokenData: appTokenData, categoryTokenData: categoryTokenData, days: nil,
            startHour: startHour, startMinute: startMinute, endHour: endHour, endMinute: endMinute,
            activeFromTimestampMs: activeFromTimestampMs, activeUntilTimestampMs: activeUntilTimestampMs,
            isPaused: isPaused, pauseEndTimestampMs: pauseEndTimestampMs
        )
        guard dayless.isActiveNow(now: t) else { return false }  // pause and date range
        guard let days, !days.isEmpty else { return true }
        let calendar = Calendar.current
        let minutes = calendar.component(.hour, from: t) * 60 + calendar.component(.minute, from: t)
        let opened = minutes >= startHour * 60 + startMinute ? t : calendar.date(byAdding: .day, value: -1, to: t) ?? t
        return days.contains((calendar.component(.weekday, from: opened) + 5) % 7)
    }

    func isPausedForStartWarning(at t: Date) -> Bool {
        guard isPaused == true else { return false }
        guard let pauseEndTimestampMs else { return true }
        return pauseEndTimestampMs > t.timeIntervalSince1970 * 1000
    }
}

enum StartWarningPlanner {
    /// One focus space: a schedule's segments together, or one manual resume.
    private struct Space {
        let name: String?
        let emoji: String?
        let isAllowlist: Bool
        let entries: [ScheduleBlockData]
        let manualResumeAt: Date?

        func enforced(at t: Date) -> Bool {
            if let manualResumeAt { return t >= manualResumeAt }
            return entries.contains { $0.enforcedForStartWarning(at: t) }
        }

        func paused(at t: Date) -> Bool {
            manualResumeAt != nil || entries.contains { $0.isPausedForStartWarning(at: t) }
        }

        func starts(from now: Date) -> [Date] {
            if let manualResumeAt { return [manualResumeAt] }
            let calendar = Calendar.current
            let today = calendar.startOfDay(for: now)
            var starts: [Date] = []
            for entry in entries {
                if entry.isPaused == true, let end = entry.pauseEndTimestampMs, end.isFinite {
                    starts.append(Date(timeIntervalSince1970: end / 1000))
                }
                guard let hour = entry.startHour, let minute = entry.startMinute else { continue }
                for offset in 0...startWarningHorizonDays {
                    guard let day = calendar.date(byAdding: .day, value: offset, to: today),
                          let start = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day) else { continue }
                    starts.append(start)
                }
            }
            return starts
        }
    }

    private struct Event {
        let fire: Date
        let start: Date
        let space: Space
        let isResume: Bool
    }

    static func plan(
        entries: [String: ScheduleBlockData],
        config: StartWarningConfig,
        now: Date = Date()
    ) -> [PlannedStartWarning] {
        guard config.enabled else { return [] }
        var events: [Event] = []
        for space in spaces(entries: entries, manualResumes: config.manualResumes ?? []) {
            for start in Set(space.starts(from: now)).sorted() {
                let fire = start.addingTimeInterval(-startWarningLeadSeconds)
                // Never late: a warning with under 5 s to go is dropped, not sent after the start.
                guard fire > now.addingTimeInterval(5) else { continue }
                let justBefore = start.addingTimeInterval(-60)
                // Only a real change warns: not in force a minute before, in force at the start.
                guard !space.enforced(at: justBefore), space.enforced(at: start) else { continue }
                events.append(Event(fire: fire, start: start, space: space, isResume: space.paused(at: justBefore)))
            }
        }

        let byFireSecond = Dictionary(grouping: events) { Int(floor($0.fire.timeIntervalSince1970)) }
        let warnings = byFireSecond.map { second, group in
            let (title, body) = content(for: group, config: config)
            return PlannedStartWarning(
                id: "\(startWarningIdPrefix)\(second)",
                fireDate: group[0].fire,
                title: title,
                body: body
            )
        }
        return Array(warnings.sorted { $0.fireDate < $1.fireDate }.prefix(startWarningCap))
    }

    private static func spaces(entries: [String: ScheduleBlockData], manualResumes: [ManualResumeWarning]) -> [Space] {
        let sortedEntries = entries.sorted { $0.key < $1.key }
        let grouped = Dictionary(grouping: sortedEntries) { $0.value.blocklistId ?? "entry:\($0.key)" }
        var spaces = grouped.keys.sorted().map { key -> Space in
            let members = grouped[key]!.map(\.value)
            return Space(
                name: members[0].blocklistName,
                emoji: members[0].blocklistEmoji,
                isAllowlist: members[0].isAllowlist,
                entries: members,
                manualResumeAt: nil
            )
        }
        for resume in manualResumes where resume.resumeAtMs.isFinite {
            spaces.append(Space(
                name: resume.name,
                emoji: resume.emoji,
                isAllowlist: resume.mode == "allowlist",
                entries: [],
                manualResumeAt: Date(timeIntervalSince1970: resume.resumeAtMs / 1000)
            ))
        }
        return spaces
    }

    private static func content(for group: [Event], config: StartWarningConfig) -> (String, String) {
        let strings = config.strings
        let locale = Locale(identifier: config.locale)
        let timeFormatter = DateFormatter()
        timeFormatter.locale = config.timeLocale.map(Locale.init(identifier:)) ?? .autoupdatingCurrent
        timeFormatter.dateStyle = .none
        timeFormatter.timeStyle = .short
        let time = timeFormatter.string(from: group[0].start)
        let names = group.map { event -> String in
            let name = event.space.name.flatMap { $0.isEmpty ? nil : $0 } ?? strings.unnamedSpace
            guard let emoji = event.space.emoji, !emoji.isEmpty else { return name }
            return "\(emoji) \(name)"
        }

        guard group.count == 1 else {
            let listFormatter = ListFormatter()
            listFormatter.locale = locale
            let joined = listFormatter.string(from: names) ?? names.joined(separator: ", ")
            return (
                fill(strings.multiTitleFmt, ["count": "\(group.count)"]),
                fill(strings.multiBodyFmt, ["names": joined, "time": time])
            )
        }
        // A resume says what the space does too: after a long pause it may be forgotten.
        let event = group[0]
        let title = event.isResume ? strings.resumeTitleFmt : strings.startTitleFmt
        let body = event.space.isAllowlist ? strings.allowBodyFmt : strings.blockBodyFmt
        return (fill(title, ["name": names[0]]), fill(body, ["time": time]))
    }

    private static func fill(_ template: String, _ values: [String: String]) -> String {
        values.reduce(template) { $0.replacingOccurrences(of: "{\($1.key)}", with: $1.value) }
    }
}

#if os(iOS) && canImport(UserNotifications)

struct StartWarningRebuildResult {
    let status: String
    let scheduled: Int
    let error: String?
}

enum StartWarningBooker {
    @MainActor private static var running: Task<StartWarningRebuildResult, Never>?

    static func statusString(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "notDetermined"
        case .denied: return "denied"
        case .authorized: return "authorized"
        case .provisional: return "provisional"
        case .ephemeral: return "ephemeral"
        @unknown default: return "unknown"
        }
    }

    static func canDeliver(_ status: UNAuthorizationStatus) -> Bool {
        status == .authorized || status == .provisional || status == .ephemeral
    }

    /// Replaces our pending warnings with the current plan. Rebuilds run one after
    /// another, so an older plan can never land on top of a newer one.
    @MainActor static func rebuild(config: StartWarningConfig) async -> StartWarningRebuildResult {
        let previous = running
        let task = Task { @MainActor () -> StartWarningRebuildResult in
            _ = await previous?.value
            return await replacePending(config: config)
        }
        running = task
        return await task.value
    }

    private static func replacePending(config: StartWarningConfig) async -> StartWarningRebuildResult {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        let ours = await center.pendingNotificationRequests().filter { $0.identifier.hasPrefix(startWarningIdPrefix) }
        let plan = canDeliver(settings.authorizationStatus)
            ? StartWarningPlanner.plan(entries: SharedScheduleStore.loadAll(), config: config)
            : []
        let planned = Set(plan.map(\.id))
        center.removePendingNotificationRequests(withIdentifiers: ours.map(\.identifier).filter { !planned.contains($0) })
        let booked = Dictionary(ours.map { ($0.identifier, $0) }, uniquingKeysWith: { first, _ in first })

        var failures: [String] = []
        for warning in plan {
            // No time zone: the warning follows the phone's wall clock, as DeviceActivity does.
            let components = Calendar.current.dateComponents(
                [.year, .month, .day, .hour, .minute, .second],
                from: warning.fireDate
            )
            // Already booked as it should be: leave it, so a rebuild is cheap.
            if let existing = booked[warning.id], existing.content.title == warning.title,
               existing.content.body == warning.body,
               (existing.trigger as? UNCalendarNotificationTrigger)?.dateComponents == components { continue }
            let content = UNMutableNotificationContent()
            content.title = warning.title
            content.body = warning.body
            content.sound = .default
            content.threadIdentifier = "redd-start-warning"
            content.interruptionLevel = .active
            let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
            do {
                // An existing id is replaced, so a rebuild never duplicates a warning.
                try await center.add(UNNotificationRequest(identifier: warning.id, content: content, trigger: trigger))
            } catch {
                failures.append("\(warning.id): \(error.localizedDescription)")
            }
        }
        return StartWarningRebuildResult(
            status: statusString(settings.authorizationStatus),
            scheduled: plan.count - failures.count,
            error: failures.isEmpty ? nil : failures.joined(separator: "; ")
        )
    }
}

/// Without a delegate iOS hides notifications while the app is in front. Tapping
/// needs no handling: iOS opens the app. Adding tauri-plugin-notification on iOS
/// later would replace this delegate, since an app has only one.
final class StartWarningPresenter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = StartWarningPresenter()

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }
}

#endif
