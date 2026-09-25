// Small, dependency-injected orchestration for timed iOS stops. Keeping the
// native calls here makes their ordering testable without a Screen Time
// entitlement or a Tauri runtime.

function nativeError(result, fallback) {
    return typeof result?.error === 'string' && result.error.trim()
        ? result.error.trim()
        : fallback;
}

/**
 * Save a manual resume payload and arm the one-off activity before committing
 * the in-memory pause. A native result is valid only when it explicitly says
 * `{ success: true }`; a missing or malformed result fails closed.
 */
export async function executeIOSResumeStop({
    tauriAPI,
    activityName,
    startTimestampMs,
    resumePayload = null,
    commit,
    restoreOnRegistrationFailure = null,
}) {
    let payloadSaved = false;
    try {
        if (resumePayload) {
            const payloadResult = await tauriAPI.screentimeSetResumePayload(resumePayload);
            if (payloadResult?.success !== true) {
                return {
                    success: false,
                    error: nativeError(payloadResult, 'Screen Time could not save the automatic restart payload'),
                };
            }
            payloadSaved = true;
        }

        const registrationResult = await tauriAPI.screentimeRegisterOneOffActivity(
            activityName,
            startTimestampMs,
        );
        if (registrationResult?.success !== true) {
            if (payloadSaved) {
                console.warn('[iOS] Automatic restart registration failed after saving its payload');
            }
            if (restoreOnRegistrationFailure) await restoreOnRegistrationFailure();
            return {
                success: false,
                error: nativeError(registrationResult, 'Screen Time could not schedule the automatic restart'),
            };
        }
    } catch (error) {
        if (restoreOnRegistrationFailure) await restoreOnRegistrationFailure();
        return {
            success: false,
            error: error?.message || String(error) || 'Screen Time could not schedule the automatic restart',
        };
    }

    await commit();
    return { success: true };
}
