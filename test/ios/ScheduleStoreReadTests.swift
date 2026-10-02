// Foundation-only tests for the shared schedule-store read outcome. Compiled and
// run on a Mac by scripts/ci/test-ios-schedule-store.sh — no App Group, no
// Screen Time frameworks, no simulator.
//
// What these protect: the monitor extension clears its shields whenever it finds
// no active schedule entries. If an unreadable or corrupt App Group also reads as
// "no entries", every live block is dropped until the app is next opened. These
// cases pin the four outcomes apart.

import Foundation

private struct StubEntry: Codable, Equatable {
    let id: String
}

private func json(_ value: some Encodable) -> Data {
    try! JSONEncoder().encode(value)
}

@main
struct ScheduleStoreReadTests {
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

    /// Pins the generic parameter so each case below reads as one line.
    private static func read(multi: Data?, legacy: Data?) -> ScheduleStoreRead<StubEntry> {
        interpretScheduleStore(multiData: multi, legacyData: legacy)
    }

    private static func entries(_ read: ScheduleStoreRead<StubEntry>) -> [String: StubEntry]? {
        if case .loaded(let entries) = read { return entries }
        return nil
    }

    static func main() {
        let multi = json(["a": StubEntry(id: "a"), "b": StubEntry(id: "b")])
        let legacy = json(StubEntry(id: "only"))
        let garbage = Data("not json".utf8)

        // An unopenable container is reported by the caller, not here; these cases
        // cover everything decidable from the stored bytes themselves.

        // Both keys absent: never written, so no entry list can be trusted.
        check(
            read(multi: nil, legacy: nil).label == "missing",
            "both keys absent reads as missing, not as an empty store"
        )

        // Unreadable bytes under the multi-schedule key.
        check(
            read(multi: garbage, legacy: nil).label == "corrupt",
            "undecodable multi-schedule data reads as corrupt, not as empty"
        )

        // Unreadable bytes under the legacy key, with no multi-schedule key.
        check(
            read(multi: nil, legacy: garbage).label == "corrupt",
            "undecodable legacy data reads as corrupt, not as empty"
        )

        // A real read with entries.
        check(
            entries(read(multi: multi, legacy: nil))?.count == 2,
            "a readable store yields its entries"
        )

        // A genuinely empty store is still "loaded": a user deleting every schedule
        // must keep clearing shields, which is why this differs from `missing`.
        check(
            entries(read(multi: json([String: StubEntry]()), legacy: nil))?.isEmpty == true,
            "an empty but written store reads as loaded with no entries"
        )

        // The legacy key is consulted only when the multi key is absent, and keys
        // its single entry as "default".
        check(
            entries(read(multi: nil, legacy: legacy))?["default"] == StubEntry(id: "only"),
            "legacy data loads under the default id"
        )

        // A present multi key wins over legacy data when both exist.
        check(
            entries(read(multi: multi, legacy: legacy))?.count == 2,
            "multi-schedule data takes precedence over legacy data"
        )

        print("\n\(checks - failures)/\(checks) passed")
        exit(failures == 0 ? 0 : 1)
    }
}
