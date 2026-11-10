import { expect, test, vi } from 'vitest';

// On iOS a document-level handler opens every external link itself. The review
// link must still run its own handler, or "don't ask again" is never saved.

const openUrl = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../src/tauri-api.js', async (orig) => ({ ...(await orig()), openUrl }));
vi.mock('../../src/onboarding.js', async (orig) => ({ ...(await orig()), hasAcceptedEula: () => true }));
vi.mock('../../src/update-banner.js', async (orig) => ({ ...(await orig()), resolveMicrosoftStorePackage: async () => null }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({}) }));

import { state } from '../../src/state.js';
import { setupMobileExternalLinkOpens } from '../../src/blocking-platform.js';
import { startStoreReviewPrompt } from '../../src/store-review-prompt.js';

test('leaving a review on iOS stops the card coming back', async () => {
    document.body.innerHTML = `<div id="store-review-prompt">
        <a href="#" id="store-review-leave-link" target="_blank">Leave a review</a></div>`;
    Object.assign(state, { isIOS: true, startupInitializationComplete: true, migrationOnboardingActive: false });
    setupMobileExternalLinkOpens();
    startStoreReviewPrompt();
    await vi.waitFor(() => expect(document.getElementById('store-review-leave-link').getAttribute('href')).toContain('apps.apple.com'));

    document.getElementById('store-review-leave-link').click();

    expect(localStorage.getItem('blockerStoreReviewNoThanks')).toBe('true');
    expect(document.getElementById('store-review-prompt').classList.contains('hidden')).toBe(true);
    expect(openUrl).toHaveBeenCalledTimes(1);
});
