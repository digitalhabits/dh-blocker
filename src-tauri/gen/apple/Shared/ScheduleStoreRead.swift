import Foundation

/// What a read of the shared schedule store found. "Could not read" must never be
/// treated as "nothing is blocked": the monitor extension clears its shields when
/// it sees no active entries, so an unreadable App Group would drop every live
/// block until the app was next opened.
enum ScheduleStoreRead<Entry> {
    /// The store was read. It may legitimately hold no entries.
    case loaded([String: Entry])
    /// The App Group container could not be opened.
    case unavailable
    /// Neither the multi-schedule nor the legacy key has ever been written.
    case missing
    /// Bytes were present but would not decode.
    case corrupt

    var label: String {
        switch self {
        case .loaded: return "loaded"
        case .unavailable: return "unavailable"
        case .missing: return "missing"
        case .corrupt: return "corrupt"
        }
    }
}

/// Decides the outcome from the stored bytes alone. Pure, and deliberately free of
/// ManagedSettings and UserDefaults so it runs in a plain Swift test on a Mac.
/// The legacy single-schedule key is only consulted when the multi-schedule key is
/// absent, matching the order the store has always used.
func interpretScheduleStore<Entry: Decodable>(
    multiData: Data?,
    legacyData: Data?
) -> ScheduleStoreRead<Entry> {
    let decoder = JSONDecoder()
    if let multiData = multiData {
        guard let decoded = try? decoder.decode([String: Entry].self, from: multiData) else {
            return .corrupt
        }
        return .loaded(decoded)
    }
    if let legacyData = legacyData {
        guard let decoded = try? decoder.decode(Entry.self, from: legacyData) else {
            return .corrupt
        }
        return .loaded(["default": decoded])
    }
    return .missing
}
