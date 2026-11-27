// Screenshots of the floating allow-mode indicator (src/allow-indicator.html).
//
// A sibling of shoot.mjs rather than more screens for it: that driver boots the
// main app through `__REDDBLOCK_INTERNALS__`, and this page is a separate
// window with no such contract. Same idea, though: Vite, headless Chromium,
// a stubbed Tauri transport, PNGs in artifacts/ui/ for a human or an agent
// to look at. Not a gate.
//
//   node scripts/ui/shoot-allow-indicator.mjs
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { startDevServer } from '../ci/lib/dev-server.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORT = process.env.UI_SHOOT_PORT || '5198';
const OUT = path.join(REPO_ROOT, 'artifacts', 'ui');

const typical = {
    active: true,
    spaces: [{ name: 'Deep work', emoji: '📚' }],
    websites: ['canvas.school.dk', 'docs.google.com', 'overleaf.com', 'wikipedia.org'],
    allWebsites: false,
    apps: ['Preview', 'Word', 'Zotero'],
    allApps: false,
    blocklistAlsoActive: false,
    endsAt: new Date(2026, 10, 27, 14, 30).getTime(),
    language: 'en',
    themeMode: 'light',
};
const manySites = Array.from({ length: 23 }, (_, i) => `site-number-${String(i + 1).padStart(2, '0')}.example.org`);

/** name, payload, then what to do before the shot. */
const SHOTS = [
    ['allow-indicator-collapsed', typical, null],
    ['allow-indicator-expanded', typical, (api) => api.setExpanded(true)],
    ['allow-indicator-expanded-dark', { ...typical, themeMode: 'dark' }, (api) => api.setExpanded(true)],
    ['allow-indicator-long', { ...typical, spaces: [{ name: 'Deep work' }, { name: 'Essay' }], websites: manySites },
        (api) => api.setExpanded(true)],
    ['allow-indicator-long-all', { ...typical, websites: manySites },
        (api) => { api.setExpanded(true); api.showAll('websites'); }],
    ['allow-indicator-apps-only-da',
        { ...typical, websites: [], allWebsites: true, blocklistAlsoActive: true, language: 'da', endsAt: undefined },
        (api) => api.setExpanded(true)],
    ['allow-indicator-long-name-collapsed',
        { ...typical, spaces: [{ name: 'A focus space with a very long name indeed, far too long' }] }, null],
];

async function main() {
    await mkdir(OUT, { recursive: true });
    const { stop } = await startDevServer({ port: PORT, bootTimeoutMs: 60_000, log: (...a) => console.log('[ui:shoot]', ...a) });
    let browser;
    try {
        browser = await chromium.launch(process.env.UI_SHOOT_CHROMIUM ? { executablePath: process.env.UI_SHOOT_CHROMIUM } : {});
        for (const [name, payload, prepare] of SHOTS) {
            const context = await browser.newContext({ viewport: { width: 480, height: 760 }, deviceScaleFactor: 2 });
            await context.addInitScript(() => {
                window.__TAURI_INTERNALS__ = {
                    invoke: () => Promise.resolve(null),
                    transformCallback: () => 1,
                    metadata: { currentWindow: { label: 'allow-indicator' }, currentWebview: { label: 'allow-indicator' } },
                };
            });
            const page = await context.newPage();
            const problems = [];
            page.on('pageerror', (e) => problems.push(e.message));
            await page.goto(`http://localhost:${PORT}/allow-indicator.html`, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => typeof window.__ALLOW_INDICATOR__ === 'object');
            await page.evaluate(({ payload, prepare }) => {
                const api = window.__ALLOW_INDICATOR__;
                api.setPayload(payload);
                if (prepare) new Function('api', `(${prepare})(api)`)(api);
            }, { payload, prepare: prepare ? prepare.toString() : null });
            await page.evaluate(() => document.fonts.ready);
            // The real window is exactly the card; clip to it.
            await page.locator('#indicator').screenshot({ path: path.join(OUT, `${name}.png`) });
            const box = await page.locator('#indicator').boundingBox();
            console.log(`[ui:shoot] ${name}: ${Math.round(box.width)}x${Math.round(box.height)}`);
            if (problems.length) throw new Error(`${name}: ${problems.join('; ')}`);
            await context.close();
        }
    } finally {
        if (browser) await browser.close();
        stop('SIGTERM');
    }
}

main().catch((err) => { console.error(err); process.exit(1); });
