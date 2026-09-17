// Website input: domain validation/parsing and the Edit Blocklist
// websites-import menu. Extracted verbatim from app.js.
import { state } from './state.js';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { tSettings } from './i18n.js';
import { isProtectedDomain, stripLeadingWww } from './blocklist-utils.js';

// Pre-made website lists offered by the Edit Blocklist "Import" menu. Each
// list is intentionally small/curated — a starting point users can prune or
// extend after import. Keys match the data-preset attributes in index.html.
const WEBSITES_PRESET_LISTS = {
    'email': [
        'gmail.com', 'mail.google.com', 'outlook.com', 'outlook.live.com',
        'mail.yahoo.com', 'icloud.com', 'mail.proton.me', 'proton.me',
        'fastmail.com', 'hey.com', 'mail.aol.com', 'mail.ru', 'gmx.com',
        'tutanota.com', 'zoho.com'
    ],
    'gambling': [
        'bet365.com', 'pokerstars.com', 'draftkings.com', 'fanduel.com',
        'betmgm.com', 'caesars.com', 'betfair.com', 'paddypower.com',
        'williamhill.com', 'ladbrokes.com', 'betway.com', 'unibet.com',
        '888.com', 'pinnacle.com', 'bovada.lv'
    ],
    'news': [
        'cnn.com', 'nytimes.com', 'bbc.com', 'bbc.co.uk', 'theguardian.com',
        'washingtonpost.com', 'reuters.com', 'apnews.com', 'foxnews.com',
        'bloomberg.com', 'wsj.com', 'ft.com', 'npr.org',
        'news.ycombinator.com', 'politico.com', 'vox.com', 'huffpost.com',
        'buzzfeed.com', 'techcrunch.com', 'theverge.com', 'wired.com',
        'arstechnica.com'
    ],
    'porn': [
        'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'redtube.com',
        'youporn.com', 'tube8.com', 'spankbang.com', 'eporner.com', 'beeg.com',
        'tnaflix.com', 'chaturbate.com', 'onlyfans.com', 'fansly.com',
        'camsoda.com'
    ],
    'search-engines': [
        'google.com', 'bing.com', 'duckduckgo.com', 'yahoo.com', 'baidu.com',
        'yandex.com', 'ecosia.org', 'kagi.com', 'brave.com', 'startpage.com',
        'swisscows.com', 'qwant.com'
    ],
    'shopping': [
        'amazon.com', 'ebay.com', 'etsy.com', 'walmart.com', 'target.com',
        'bestbuy.com', 'costco.com', 'aliexpress.com', 'alibaba.com',
        'shein.com', 'temu.com', 'wish.com', 'newegg.com', 'ikea.com',
        'macys.com', 'nike.com', 'adidas.com', 'zara.com', 'hm.com'
    ],
    'social-media': [
        'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'tiktok.com',
        'snapchat.com', 'linkedin.com', 'pinterest.com', 'reddit.com',
        'tumblr.com', 'threads.net', 'mastodon.social', 'bsky.app',
        'discord.com', 'whatsapp.com', 'web.whatsapp.com', 't.me',
        'telegram.org'
    ]
};

// Validate that a string looks like a valid domain (e.g. reddit.com, example.co.uk)
export function isValidDomain(str) {
    // Strip protocol and path if user pasted a URL
    let domain = str.replace(/^https?:\/\//i, '').split('/')[0].split('?')[0].split('#')[0];
    // Must have at least one dot, only valid domain chars, and a TLD of 2+ chars
    return /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain);
}

// Clean a user input string into a domain. A leading `www.` is dropped so the
// entry covers the whole site — see `stripLeadingWww`.
export function cleanDomainInput(str) {
    const host = str.trim().replace(/^https?:\/\//i, '').split('/')[0].split('?')[0].split('#')[0].toLowerCase().trim();
    return stripLeadingWww(host);
}

// Parse input that may contain multiple domains (space, newline, or comma separated)
export function parseDomainList(raw) {
    if (!raw || !raw.trim()) return [];
    return raw.split(/\s+|,/).map(s => cleanDomainInput(s)).filter(Boolean);
}

/** Process raw website input: parse, validate, classify. Returns result for keydown/save handlers. */
export function processWebsiteInput(raw) {
    const domains = parseDomainList(raw);
    const invalid = domains.filter(d => !isValidDomain(d));
    const valid = domains.filter(d => isValidDomain(d));
    const protectedList = valid.filter(d => isProtectedDomain(d));
    const toAdd = valid.filter(d => !isProtectedDomain(d));
    return {
        invalid,
        toAdd,
        websiteInvalid: invalid.length > 0,
        inputValueToSet: invalid.length === 0 ? '' : invalid.join(' '),
        hadProtected: protectedList.length > 0
    };
}

// Parse a text-file's contents into a flat list of candidate domains. Each
// non-comment line may contain one or more space/comma-separated domains.
// '#' starts a line/inline comment (hosts-file style). Returns raw strings,
// not yet validated.
export function parseTextFileDomains(content) {
    if (!content) return [];
    const out = [];
    for (const rawLine of content.split(/\r?\n/)) {
        const beforeComment = rawLine.split('#')[0];
        if (!beforeComment.trim()) continue;
        for (const token of parseDomainList(beforeComment)) {
            if (token) out.push(token);
        }
    }
    return out;
}

export function resetWebsitesImportMenuPosition(menuId = 'websites-import-menu') {
    const menu = document.getElementById(menuId);
    if (!menu) return;
    menu.classList.remove('websites-import-menu-fixed');
    menu.style.top = '';
    menu.style.bottom = '';
    menu.style.left = '';
    menu.style.right = '';
    menu.style.width = '';
    menu.style.minWidth = '';
    menu.style.maxHeight = '';
}

// Wire up a websites "Import" / Lists popover. The caller supplies a callback
// that receives an array of cleaned domain strings; it's responsible for
// de-duplicating against current modal state.
export function setupWebsitesImportMenu({
    addDomainsToModal,
    importBtnId = 'modal-import-websites-btn',
    menuId = 'websites-import-menu',
    textFileBtnId = 'websites-import-menu-text-file',
}) {
    const importBtn = document.getElementById(importBtnId);
    const menu = document.getElementById(menuId);
    if (!importBtn || !menu) return;

    menu._importBtn = importBtn;

    const resetMenuPosition = () => {
        resetWebsitesImportMenuPosition(menuId);
    };

    const positionMenu = () => {
        const rect = importBtn.getBoundingClientRect();
        const viewportPadding = 12;
        const gap = 4;
        const isIOS = document.body.classList.contains('ios');

        menu.classList.add('websites-import-menu-fixed');
        menu.style.left = 'auto';
        menu.style.right = `${Math.max(viewportPadding, window.innerWidth - rect.right)}px`;
        menu.style.maxHeight = '';

        if (isIOS) {
            menu.style.width = '';
            menu.style.minWidth = '';
        } else {
            const minWidth = Math.max(rect.width, 220);
            menu.style.width = `${minWidth}px`;
            menu.style.minWidth = `${minWidth}px`;
        }

        menu.style.top = '';
        menu.style.bottom = '';

        const modalContent = importBtn.closest('.modal-content');
        const header = modalContent?.querySelector('.mobile-modal-header');
        const topLimit = header
            ? header.getBoundingClientRect().bottom
            : viewportPadding;
        const footer = modalContent?.querySelector(':scope > .modal-buttons');
        const bottomLimit = footer
            ? footer.getBoundingClientRect().top
            : window.innerHeight - viewportPadding;

        const menuHeight = menu.scrollHeight;
        const spaceBelow = bottomLimit - rect.bottom - gap;
        const spaceAbove = rect.top - topLimit - gap;
        const fitsAbove = spaceAbove >= menuHeight;
        const openUpward = spaceBelow < menuHeight && fitsAbove;

        if (openUpward) {
            menu.style.top = 'auto';
            menu.style.bottom = `${Math.max(viewportPadding, window.innerHeight - rect.top + gap)}px`;
        } else {
            menu.style.bottom = 'auto';
            menu.style.top = `${Math.max(viewportPadding, rect.bottom + gap)}px`;
        }
    };

    const closeMenu = () => {
        menu.classList.add('hidden');
        importBtn.setAttribute('aria-expanded', 'false');
        resetMenuPosition();
    };
    const openMenu = () => {
        menu.classList.remove('hidden');
        importBtn.setAttribute('aria-expanded', 'true');
        requestAnimationFrame(positionMenu);
    };

    importBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menu.classList.contains('hidden')) {
            openMenu();
        } else {
            closeMenu();
        }
    });

    // Close on outside click / Escape.
    document.addEventListener('click', (e) => {
        if (menu.classList.contains('hidden')) return;
        if (!menu.contains(e.target) && !importBtn.contains(e.target)) {
            closeMenu();
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !menu.classList.contains('hidden')) {
            closeMenu();
        }
    });

    menu.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });
    menu.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    window.addEventListener('resize', () => {
        if (!menu.classList.contains('hidden')) positionMenu();
    });

    const textFileBtn = document.getElementById(textFileBtnId);
    if (textFileBtn) {
        textFileBtn.addEventListener('click', async () => {
            closeMenu();
            try {
                const selected = await openDialog({
                    multiple: false,
                    title: tSettings('importWebsitesPickFileTitle'),
                    filters: [
                        { name: 'Text', extensions: ['txt', 'list', 'csv'] },
                        { name: 'All files', extensions: ['*'] }
                    ]
                });
                if (!selected || typeof selected !== 'string') return;
                const contents = await readTextFile(selected);
                addDomainsToModal(parseTextFileDomains(contents));
            } catch (err) {
                console.warn('[import] text file:', err);
            }
        });
    }

    menu.querySelectorAll('[data-preset]').forEach(btn => {
        btn.addEventListener('click', () => {
            closeMenu();
            const preset = btn.dataset.preset;
            const list = WEBSITES_PRESET_LISTS[preset];
            if (!list) return;
            addDomainsToModal(list);
        });
    });
}
