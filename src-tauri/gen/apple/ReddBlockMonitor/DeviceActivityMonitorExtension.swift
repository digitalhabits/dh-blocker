import DeviceActivity
import ManagedSettings
import Foundation

/// DeviceActivityMonitor extension that applies/clears blocks when scheduled time windows start/end.
/// This runs as a separate process — it does NOT have access to the main app's memory.
/// It reads schedule data from the shared App Group UserDefaults.
@available(iOS 16.0, *)
class ReddBlockMonitor: DeviceActivityMonitor {
    
    /// Use a NAMED store for schedule-based blocks so they don't interfere
    /// with manual blocks in the default ManagedSettingsStore.
    /// The ScreentimePlugin uses ManagedSettingsStore() (default) for manual
    /// blocks — these two stores stack independently at the OS level.
    private let store = ManagedSettingsStore(named: .init("schedule"))
    
    /// Default store for manual blocks (resume/block-end one-offs write here).
    private let defaultStore = ManagedSettingsStore()
    
    /// Called by the system when a scheduled DeviceActivity interval starts.
    override func intervalDidStart(for activity: DeviceActivityName) {
        super.intervalDidStart(for: activity)
        
        let raw = activity.rawValue
        NSLog("[ReDD Schedule] intervalDidStart raw=%@", raw)

        if raw.hasPrefix("redd-schedule-resume-") {
            recomputeActiveScheduleUnion()
            return
        }
        
        // One-off: pause resume — merge manual state + resume payload and apply to default store
        if raw.hasPrefix("redd-block-resume-") {
            let blockId = String(raw.dropFirst("redd-block-resume-".count))
            handleResumeOneOff(blockId: blockId)
            return
        }
        
        // One-off: block end — load current manual state, subtract this block's payload, apply, write back (Option B)
        if raw.hasPrefix("redd-block-end-") {
            let blockId = String(raw.dropFirst("redd-block-end-".count))
            handleBlockEndOneOff(blockId: blockId)
            return
        }
        
        // Regular schedule segment
        recomputeActiveScheduleUnion()
    }
    
    /// Re-tag a merged/subtracted payload as allowlist so the record keeps its semantics.
    private func taggedAllowlist(_ payload: ManualBlockStatePayload) -> ManualBlockStatePayload {
        ManualBlockStatePayload(
            domains: payload.domains,
            appTokenData: payload.appTokenData,
            categoryTokenData: payload.categoryTokenData,
            days: nil,
            mode: "allowlist"
        )
    }
    
    /// Re-derive both channels' web filters and app/category shields from
    /// App Group state (allowlist-aware, cross-channel). Callers must persist
    /// their record updates BEFORE calling this.
    private func reapplyDerivedPolicies(now: Date = Date()) {
        IOSWebPolicyApplier.reapplyWebPolicy(now: now)
        IOSAppPolicyApplier.reapplyAppPolicy(now: now)
    }

    /// Handle one-off resume: merge the resume payload into the record matching its
    /// mode (blocked vs allowed are separate App Group records), re-apply, clean up.
    private func handleResumeOneOff(blockId: String) {
        guard let resumePayload = SharedManualBlockStore.loadResumePayload(blockId: blockId) else {
            return
        }
        if resumePayload.isAllowlist {
            let base = SharedManualBlockStore.loadManualAllowlistState()
            let merged = taggedAllowlist(mergePayloads(base: base, extra: resumePayload))
            SharedManualBlockStore.saveManualAllowlistState(merged)
        } else {
            let base = SharedManualBlockStore.loadManualBlockState()
            let merged = mergePayloads(base: base, extra: resumePayload)
            SharedManualBlockStore.saveManualBlockState(merged)
        }
        reapplyDerivedPolicies()
        SharedManualBlockStore.removeResumePayload(blockId: blockId)
    }

    /// Handle one-off block end (Option B): subtract this block's payload from the
    /// record matching its mode, re-apply, write back.
    private func handleBlockEndOneOff(blockId: String) {
        guard let toRemove = SharedManualBlockStore.loadBlockEndState(blockId: blockId) else {
            return
        }
        let emptyPayload = ManualBlockStatePayload(domains: [], appTokenData: [], categoryTokenData: [], days: nil)
        if toRemove.isAllowlist {
            let current = SharedManualBlockStore.loadManualAllowlistState()
            let newState = taggedAllowlist(subtractPayloads(current: current ?? emptyPayload, subtract: toRemove))
            if newState.isEmptyPayload {
                SharedManualBlockStore.clearManualAllowlistState()
            } else {
                SharedManualBlockStore.saveManualAllowlistState(newState)
            }
        } else {
            let current = SharedManualBlockStore.loadManualBlockState()
            let newState = subtractPayloads(current: current ?? emptyPayload, subtract: toRemove)
            SharedManualBlockStore.saveManualBlockState(newState)
            if newState.isEmptyPayload {
                // Clear residual default-store settings; the derived reapply
                // below restores anything a still-active source needs.
                defaultStore.clearAllSettings()
            }
        }
        reapplyDerivedPolicies()
        SharedManualBlockStore.removeBlockEndState(blockId: blockId)
    }
    
    /// Subtract "to remove" payload from current (set difference for domains; filter out matching app/category tokens).
    private func subtractPayloads(current: ManualBlockStatePayload, subtract: ManualBlockStatePayload) -> ManualBlockStatePayload {
        let domainSet = Set(current.domains).subtracting(subtract.domains)
        let subtractAppSet = Set(subtract.appTokenData)
        let appTokenData = current.appTokenData.filter { !subtractAppSet.contains($0) }
        let subtractCategorySet = Set(subtract.categoryTokenData)
        let categoryTokenData = current.categoryTokenData.filter { !subtractCategorySet.contains($0) }
        return ManualBlockStatePayload(
            domains: Array(domainSet),
            appTokenData: appTokenData,
            categoryTokenData: categoryTokenData,
            days: nil
        )
    }
    
    /// Merge two payloads (union of domains, appTokenData, categoryTokenData).
    private func mergePayloads(base: ManualBlockStatePayload?, extra: ManualBlockStatePayload) -> ManualBlockStatePayload {
        let domains = Set(base?.domains ?? []).union(extra.domains)
        var appTokenData = base?.appTokenData ?? []
        for s in extra.appTokenData where !appTokenData.contains(s) {
            appTokenData.append(s)
        }
        var categoryTokenData = base?.categoryTokenData ?? []
        for s in extra.categoryTokenData where !categoryTokenData.contains(s) {
            categoryTokenData.append(s)
        }
        return ManualBlockStatePayload(
            domains: Array(domains),
            appTokenData: appTokenData,
            categoryTokenData: categoryTokenData,
            days: nil
        )
    }
    
    /// Called by the system when a scheduled DeviceActivity interval ends.
    override func intervalDidEnd(for activity: DeviceActivityName) {
        super.intervalDidEnd(for: activity)
        
        let raw = activity.rawValue
        NSLog("[ReDD Schedule] intervalDidEnd raw=%@", raw)
        // One-off resume/block-end: we only care about intervalDidStart; do not clear default store when interval ends
        if raw.hasPrefix("redd-schedule-resume-") || raw.hasPrefix("redd-block-resume-") || raw.hasPrefix("redd-block-end-") {
            return
        }
        
        recomputeActiveScheduleUnion()
    }

    /// Called before a padded short interval ends. We use this to recompute at
    /// the schedule's real end time when the registered DeviceActivity interval
    /// had to be stretched to Apple's 15-minute minimum.
    override func intervalWillEndWarning(for activity: DeviceActivityName) {
        super.intervalWillEndWarning(for: activity)

        let raw = activity.rawValue
        NSLog("[ReDD Schedule] intervalWillEndWarning raw=%@", raw)
        if raw.hasPrefix("redd-schedule-resume-") || raw.hasPrefix("redd-block-resume-") || raw.hasPrefix("redd-block-end-") {
            return
        }

        recomputeActiveScheduleUnion()
    }
    
    // MARK: - Helpers
    
    /// Recompute enforcement for all schedule entries that are active at "now".
    /// This prevents stale shields and keeps overlap handling consistent on
    /// start/end events. Web content and app/category shields are derived state
    /// owned by the shared appliers (allowlist-aware, cross-channel); this
    /// method owns clearing when nothing is active and the shield snapshot
    /// (the writer partitions blocklist rows vs the allowlist fallback itself).
    private func recomputeActiveScheduleUnion(now: Date = Date()) {
        let allSchedules = SharedScheduleStore.loadAll()
        NSLog("[ReDD Schedule] recomputeActiveScheduleUnion schedules=%d", allSchedules.count)
        var activePairs: [(String, ScheduleBlockData)] = []

        for (id, data) in allSchedules where data.isActiveNow(now: now) {
            NSLog(
                "[ReDD Schedule] active schedule id=%@ mode=%@ domains=%d apps=%d categories=%d",
                id, data.mode ?? "blocklist", data.domains.count, data.appTokenData.count, data.categoryTokenData.count
            )
            activePairs.append((id, data))
        }

        if activePairs.isEmpty {
            store.clearAllSettings()
        }
        ShieldScheduleSnapshotWriter.persistScheduleUnion(activeEntries: activePairs, now: now)
        reapplyDerivedPolicies(now: now)
    }

    /// Extract a schedule ID from a DeviceActivityName.
    /// Activity names follow the format "redd-block-{id}".
    /// Falls back to "default" for the legacy "redd-block-schedule" name.
    private func extractScheduleId(from activity: DeviceActivityName) -> String {
        let raw = activity.rawValue
        if raw.hasPrefix("redd-block-") {
            let id = String(raw.dropFirst("redd-block-".count))
            return id.isEmpty ? "default" : id
        }
        // Legacy name
        return "default"
    }
}
