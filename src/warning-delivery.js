// Event payloads can arrive after release. Only the watcher's current pending
// snapshot may create an acknowledgement row. Invalidate reads on hide/ack so
// a response captured before either transition cannot resurrect an old warning.
export function createWarningDelivery(readPending, applyPending) {
    let revision = 0;
    return {
        invalidate() { revision++; },
        async refresh() {
            const requested = ++revision;
            let pending;
            // Read-only retry, never an enforcement/acknowledgement action.
            for (let attempt = 0; attempt < 3; attempt++) {
                try { pending = await readPending(); break; }
                catch (error) {
                    if (requested !== revision) return false;
                    if (attempt === 2) throw error;
                }
            }
            if (requested !== revision) return false;
            if (!Array.isArray(pending)) throw new Error('Invalid pending warning snapshot');
            applyPending(pending);
            return true;
        },
    };
}
