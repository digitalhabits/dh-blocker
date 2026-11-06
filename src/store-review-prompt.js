import { getCurrentWindow } from '@tauri-apps/api/window';
import { state } from './state.js';
import { openUrl } from './tauri-api.js';
import { hasAcceptedEula } from './onboarding.js';
import { resolveMicrosoftStorePackage } from './update-banner.js';
import { tSettings } from './i18n.js';

const OPENS_KEY = 'blockerStoreReviewOpensCount';
const NO_THANKS_KEY = 'blockerStoreReviewNoThanks';
const STAR = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
const IOS_URL = 'https://apps.apple.com/gb/app/redd-block-focus-simply/id6759917048?action=write-review';
const WIN_URL = 'ms-windows-store://review/?ProductId=9NVJFPDMBLJ1';

let wired = false;
let booted = false;
let counting = false;
let visitOpen = false;

function lsGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}

function lsSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

function opensCount() {
    const n = parseInt(lsGet(OPENS_KEY) || '', 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

function card(show) {
    document.getElementById('store-review-prompt')?.classList.toggle('hidden', !show);
}

/** iOS App Store, or the Windows MSIX package. Direct Windows installs do not ask. */
async function reviewUrl() {
    if (state.isIOS) return IOS_URL;
    if (navigator.platform.toUpperCase().includes('MAC')) return null;
    return (await resolveMicrosoftStorePackage()) ? WIN_URL : null;
}

function deferred() {
    return state.migrationOnboardingActive || !hasAcceptedEula() || !state.startupInitializationComplete;
}

function wire(url) {
    if (wired) return;
    wired = true;
    const stars = document.querySelector('.store-review-prompt-stars');
    if (stars && !stars.childElementCount) stars.innerHTML = STAR.repeat(5);
    const link = document.getElementById('store-review-leave-link');
    const optOut = () => {
        lsSet(NO_THANKS_KEY, 'true');
        card(false);
    };
    if (link) {
        link.href = url;
        link.addEventListener('click', (event) => {
            event.preventDefault();
            optOut();
            void openUrl(url);
        });
    }
    document.getElementById('store-review-no-thanks')?.addEventListener('click', optOut);
    document.getElementById('store-review-dismiss')?.addEventListener('click', () => card(false));
    if (import.meta.env.DEV) window.previewStoreReviewPrompt = () => card(true);
}

async function uiIsShown() {
    if (state.isIOS) return document.visibilityState === 'visible';
    try { return await getCurrentWindow().isVisible(); }
    catch { return document.visibilityState === 'visible'; }
}

async function onUiShown() {
    if (!counting || deferred()) return;
    if (!(await uiIsShown())) {
        visitOpen = false;
        return;
    }
    if (visitOpen) return;
    visitOpen = true;
    const n = opensCount() + 1;
    lsSet(OPENS_KEY, String(n));
    if (n % 10 === 0 && lsGet(NO_THANKS_KEY) !== 'true') card(true);
}

export function startStoreReviewPrompt() {
    if (!booted) {
        booted = true;
        void (async () => {
            const url = await reviewUrl();
            const mac = navigator.platform.toUpperCase().includes('MAC');
            const link = url || (import.meta.env.DEV && !mac ? WIN_URL : null);
            if (!link) return;
            wire(link);
            if (!url) return;
            counting = true;
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') visitOpen = false;
                else void onUiShown();
            });
            if (!state.isIOS) {
                getCurrentWindow().onFocusChanged(({ payload: focused }) => {
                    if (focused) void onUiShown();
                }).catch(() => {});
            }
            void onUiShown();
        })();
        return;
    }
    void onUiShown();
}

export function applyStoreReviewPromptCopy() {
    const text = {
        'store-review-prompt-body': tSettings('storeReviewPromptBody'),
        'store-review-leave-link': tSettings('storeReviewLeaveReview'),
        'store-review-no-thanks': tSettings('storeReviewAlreadyDid'),
    };
    for (const [id, value] of Object.entries(text)) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    }
    document.getElementById('store-review-dismiss')?.setAttribute('aria-label', tSettings('storeReviewDismissAria'));
}
