import changelogMarkdown from '../changelog.md?raw';

/**
 * @typedef {{ title: string, body: string, tags?: string[] }} ReleaseNoteItem
 * @typedef {{ label: string, items: ReleaseNoteItem[], children: ReleaseNoteGroup[] }} ReleaseNoteGroup
 * @typedef {{ summary: ReleaseNoteItem | null, groups: ReleaseNoteGroup[] }} ParsedReleaseNotes
 */

const PLATFORM_TAG_RE = /^\[(desktop|macos|windows|ios|android)\]\s*/i;

/**
 * @param {string} text
 * @returns {{ tags: string[], rest: string }}
 */
function takePlatformTags(text) {
    let rest = String(text || '').trim();
    /** @type {string[]} */
    const tags = [];
    let match = rest.match(PLATFORM_TAG_RE);
    while (match) {
        tags.push(match[1].toLowerCase());
        rest = rest.slice(match[0].length).trim();
        match = rest.match(PLATFORM_TAG_RE);
    }
    return { tags, rest };
}

/**
 * @param {string[] | undefined} tags
 * @param {string} platform
 */
function tagsMatchPlatform(tags, platform) {
    if (!tags || !tags.length) return true;
    if (tags.includes(platform)) return true;
    if ((platform === 'windows' || platform === 'macos') && tags.includes('desktop')) {
        return true;
    }
    return false;
}

const REMOTE_CHANGELOG_URLS = [
    'https://digitalhabits.github.io/dh-blocker/changelog.md',
    'https://raw.githubusercontent.com/digitalhabits/dh-blocker/main/changelog.md',
];

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** `**bold**`, `*italics*` / `_italics_` in already-escaped text. */
function formatEmphasisHtml(escaped) {
    return escaped
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*(?!\*)/g, '$1<em>$2</em>')
        .replace(/(^|[\s(])_([^_\s](?:[^_]*[^_\s])?)_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
}

/**
 * Inline markdown — `**bold**`, `*italics*`, `[label](https://url)` —
 * in already-escaped text. Only http(s)/mailto link targets are
 * rendered; anything else stays as literal text. Anchors are swapped
 * out for placeholders while emphasis runs so `*`/`_` inside a URL
 * can't corrupt the markup.
 */
export function formatChangelogInlineHtml(text) {
    const escaped = escapeHtml(text);
    /** @type {string[]} */
    const anchors = [];
    const withPlaceholders = escaped.replace(
        /\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s()]+)\)/g,
        (_match, label, url) => {
            anchors.push(`<a href="${url}" target="_blank" rel="noopener noreferrer" data-external-url="${url}">${formatEmphasisHtml(label)}</a>`);
            return `\u0000${anchors.length - 1}\u0000`;
        },
    );
    return formatEmphasisHtml(withPlaceholders)
        .replace(/\u0000(\d+)\u0000/g, (_match, index) => anchors[Number(index)]);
}

function parseBulletItem(text) {
    const { tags, rest } = takePlatformTags(text);
    const trimmed = rest.trim();
    if (!trimmed || /^\*\*Version:\*\*/i.test(trimmed) || /^Version:\s*/i.test(trimmed)) {
        return null;
    }

    const match = trimmed.match(/^\*\*([^*]+)\*\*(.*)$/s);
    if (!match) {
        return { title: trimmed, body: '', tags };
    }
    return {
        title: match[1].trim(),
        body: match[2].trim().replace(/^\.\s*/, ''),
        tags,
    };
}

function parseBlockquoteSummary(lines) {
    const text = lines.map((line) => line.trim()).filter(Boolean).join(' ');
    if (!text) return null;
    return parseBulletItem(text) || { title: text, body: '' };
}

/** @param {ReleaseNoteGroup} group */
function groupHasContent(group) {
    return group.items.length > 0 || group.children.some(groupHasContent);
}

/** @returns {ReleaseNoteGroup} */
function createGroup(label) {
    return { label, items: [], children: [] };
}

function inferLegacyBuckets(items) {
    /** @type {ReleaseNoteItem[]} */
    const crossPlatform = [];
    /** @type {ReleaseNoteItem[]} */
    const desktopShared = [];
    /** @type {ReleaseNoteItem[]} */
    const macItems = [];
    /** @type {ReleaseNoteItem[]} */
    const winItems = [];
    /** @type {ReleaseNoteItem[]} */
    const iosItems = [];

    for (const item of items) {
        const lower = item.title.toLowerCase();
        if (/^macos\b/.test(lower)) macItems.push(item);
        else if (/^windows\b/.test(lower)) winItems.push(item);
        else if (/^ios\b/.test(lower)) iosItems.push(item);
        else if (lower.startsWith('desktop')) desktopShared.push(item);
        else if (lower.includes('focus room') || lower.includes('focus space') || lower.includes('schedule')
            || lower.includes('danish') || lower.includes('localization')
            || /meet |rebrand|introducing/.test(lower)) {
            crossPlatform.push(item);
        } else {
            desktopShared.push(item);
        }
    }

    /** @type {ReleaseNoteGroup[]} */
    const groups = [];
    if (crossPlatform.length) {
        groups.push({ label: 'IMPROVEMENTS', items: crossPlatform, children: [] });
    }

    const desktopChildren = [];
    if (desktopShared.length) {
        desktopChildren.push({ label: 'All desktop', items: desktopShared, children: [] });
    }
    if (macItems.length) {
        desktopChildren.push({ label: 'macOS', items: macItems, children: [] });
    }
    if (winItems.length) {
        desktopChildren.push({ label: 'Windows', items: winItems, children: [] });
    }
    if (iosItems.length) {
        desktopChildren.push({ label: 'iOS', items: iosItems, children: [] });
    }
    if (desktopChildren.length) {
        groups.push({
            label: 'BY PLATFORM',
            items: [],
            children: [{ label: 'DESKTOP', items: [], children: desktopChildren }],
        });
    }

    return groups;
}

/**
 * Parse a version section into a summary plus grouped release notes.
 * Supports `> …` summary, `###` / `####` / `#####` headings, and bullets.
 * Put cross-platform sections first, then `### BY PLATFORM` → `#### DESKTOP`
 * → `##### macOS` / `##### Windows` / `##### iOS`.
 *
 * @param {string} markdown
 * @param {string} version
 * @returns {ParsedReleaseNotes}
 */
export function parseReleaseNotes(markdown, version) {
    const normalized = String(version || '').replace(/^v/i, '').trim();
    const empty = { summary: null, groups: [] };
    if (!normalized || !markdown) return empty;

    const sectionRe = new RegExp(`^## v${escapeRegExp(normalized)}\\s*$`);
    const lines = markdown.split(/\r?\n/);
    let inSection = false;

    /** @type {string[]} */
    let blockquoteLines = [];
    /** @type {ReleaseNoteItem | null} */
    let summary = null;
    /** @type {ReleaseNoteGroup[]} */
    const groups = [];
    /** @type {ReleaseNoteGroup[]} */
    let groupStack = [];
    /** @type {ReleaseNoteItem[]} */
    let looseItems = [];
    let currentBullet = null;

    const flushBullet = () => {
        if (!currentBullet) return;
        const item = parseBulletItem(currentBullet);
        currentBullet = null;
        if (!item) return;
        const target = groupStack[groupStack.length - 1];
        if (target) target.items.push(item);
        else looseItems.push(item);
    };

    const flushBlockquote = () => {
        if (!blockquoteLines.length) return;
        summary = parseBlockquoteSummary(blockquoteLines);
        blockquoteLines = [];
    };

    for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (/^##\s/.test(line)) {
            if (inSection) break;
            if (sectionRe.test(line)) inSection = true;
            continue;
        }
        if (!inSection) continue;

        if (line.startsWith('> ')) {
            flushBullet();
            blockquoteLines.push(line.slice(2));
            continue;
        }

        const headingMatch = line.match(/^(#{3,5})\s+(.+)$/);
        if (headingMatch) {
            flushBullet();
            flushBlockquote();
            const depth = headingMatch[1].length - 3;
            const group = createGroup(headingMatch[2].trim());

            if (depth === 0) {
                groups.push(group);
                groupStack = [group];
            } else if (depth === 1) {
                const parent = groupStack[0];
                if (parent) {
                    parent.children.push(group);
                    groupStack = [parent, group];
                } else {
                    groups.push(group);
                    groupStack = [group];
                }
            } else if (depth >= 2) {
                const parent = groupStack[1] || groupStack[0];
                if (parent) {
                    parent.children.push(group);
                    groupStack = groupStack.slice(0, 2).concat(group);
                } else {
                    groups.push(group);
                    groupStack = [group];
                }
            }
            continue;
        }

        if (line.startsWith('- ')) {
            flushBullet();
            currentBullet = line.slice(2).trim();
            continue;
        }

        if (currentBullet && line.trim() && !line.startsWith('#')) {
            currentBullet += ` ${line.trim()}`;
        }
    }

    flushBullet();
    flushBlockquote();

    if (groups.length === 0 && looseItems.length) {
        return { summary, groups: inferLegacyBuckets(looseItems) };
    }

    return { summary, groups };
}

/** @param {string} label */
function normalizeGroupLabel(label) {
    return String(label || '').trim().toLowerCase();
}

/** @param {string} platformKey @returns {'windows' | 'macos' | 'ios' | null} */
function normalizePlatformKey(platformKey) {
    const key = String(platformKey || '').trim().toLowerCase();
    if (key === 'windows' || key === 'macos' || key === 'ios') {
        return key;
    }
    return null;
}

/** @param {string} label @param {string} platformKey */
function labelMatchesPlatform(label, platformKey) {
    return normalizeGroupLabel(label) === platformKey;
}

/**
 * Filter release notes for the current device.
 *
 * - Drops `### Internal` (GitHub-only).
 * - Keeps untagged bullets plus `[desktop]` / OS tags that match this device.
 * - Still flattens legacy `### BY PLATFORM` → `#### DESKTOP` nesting.
 *
 * @param {ParsedReleaseNotes} notes
 * @param {string | null | undefined} platformKey `windows` | `macos` | `ios`
 * @returns {ParsedReleaseNotes}
 */
export function filterReleaseNotesForPlatform(notes, platformKey) {
    const platform = normalizePlatformKey(platformKey);
    if (!notes) {
        return notes;
    }

    /**
     * @param {ReleaseNoteGroup} group
     * @returns {ReleaseNoteGroup | null}
     */
    const filterTaggedGroup = (group) => {
        if (normalizeGroupLabel(group.label) === 'internal') {
            return null;
        }

        const items = platform
            ? group.items.filter((item) => tagsMatchPlatform(item.tags, platform))
            : [...group.items];
        const children = [];
        for (const child of group.children || []) {
            const filteredChild = filterTaggedGroup(child);
            if (filteredChild) children.push(filteredChild);
        }
        if (!items.length && !children.length) return null;
        return { label: group.label, items, children };
    };

    /** @type {ReleaseNoteGroup[]} */
    const groups = [];

    for (const group of notes.groups || []) {
        if (normalizeGroupLabel(group.label) === 'internal') {
            continue;
        }

        if (normalizeGroupLabel(group.label) !== 'by platform') {
            const filtered = filterTaggedGroup(group);
            if (filtered) groups.push(filtered);
            continue;
        }

        if (!platform) continue;

        for (const child of group.children || []) {
            // Platform section at the same level as DESKTOP (e.g. `#### iOS`).
            if (labelMatchesPlatform(child.label, platform)) {
                groups.push({
                    label: child.label,
                    items: [...child.items],
                    children: [],
                });
                continue;
            }
            if (normalizeGroupLabel(child.label) !== 'desktop') {
                continue;
            }

            if (platform !== 'ios') {
                /** @type {ReleaseNoteItem[]} */
                const desktopItems = [...child.items];
                for (const nested of child.children || []) {
                    if (normalizeGroupLabel(nested.label) === 'all desktop') {
                        desktopItems.push(...nested.items);
                    }
                }
                if (desktopItems.length) {
                    groups.push({ label: 'Desktop', items: desktopItems, children: [] });
                }
            }

            for (const nested of child.children || []) {
                if (labelMatchesPlatform(nested.label, platform)) {
                    groups.push({
                        label: nested.label,
                        items: [...nested.items],
                        children: [],
                    });
                }
            }
        }
    }

    return { summary: notes.summary, groups };
}

/**
 * @param {ParsedReleaseNotes} notes
 * @returns {boolean}
 */
export function releaseNotesHasContent(notes) {
    return !!(notes?.summary || notes?.groups?.some(groupHasContent));
}

/** @param {ReleaseNoteItem[]} items */
function renderItemsListHtml(items) {
    return items.map((item) => {
        // Plain Fixes-and-Polish style: no bold lead-in, only a single sentence.
        if (!item.body) {
            return `<li class="update-banner-notes-item">
            <span class="update-banner-notes-item-body">${formatChangelogInlineHtml(item.title)}</span>
        </li>`;
        }
        const bodyHtml = `<span class="update-banner-notes-item-body">${formatChangelogInlineHtml(item.body)}</span>`;
        return `<li class="update-banner-notes-item">
            <span class="update-banner-notes-item-title"><strong>${formatChangelogInlineHtml(item.title)}</strong></span>
            ${bodyHtml}
        </li>`;
    }).join('');
}

/**
 * @param {ReleaseNoteGroup} group
 * @param {number} depth
 * @returns {string}
 */
function renderGroupHtml(group, depth = 0) {
    if (!groupHasContent(group)) return '';

    const sectionClass = depth === 0
        ? 'update-banner-notes-group'
        : depth === 1
            ? 'update-banner-notes-subgroup'
            : 'update-banner-notes-subsubgroup';
    const labelClass = depth === 0
        ? 'update-banner-notes-group-label'
        : depth === 1
            ? 'update-banner-notes-subgroup-label'
            : 'update-banner-notes-subsubgroup-label';
    const labelTag = depth === 0 ? 'h4' : depth === 1 ? 'h5' : 'h6';

    const itemsHtml = group.items.length
        ? `<ul class="update-banner-notes-items">${renderItemsListHtml(group.items)}</ul>`
        : '';
    const childrenHtml = group.children.map((child) => renderGroupHtml(child, depth + 1)).join('');

    return `<section class="${sectionClass}">
        <${labelTag} class="${labelClass}">${escapeHtml(group.label)}</${labelTag}>
        ${itemsHtml}
        ${childrenHtml}
    </section>`;
}

/**
 * @param {ParsedReleaseNotes} notes
 * @returns {string}
 */
export function renderReleaseNotesHtml(notes) {
    if (!releaseNotesHasContent(notes)) return '';

    const parts = [];

    if (notes.summary) {
        parts.push(`<div class="update-banner-notes-summary">
            <p class="update-banner-notes-summary-title"><span class="update-banner-notes-summary-emoji" aria-hidden="true">🎉</span> ${formatChangelogInlineHtml(notes.summary.title)}</p>
            ${notes.summary.body ? `<p class="update-banner-notes-summary-body">${formatChangelogInlineHtml(notes.summary.body)}</p>` : ''}
        </div>`);
    }

    for (const group of notes.groups) {
        const html = renderGroupHtml(group, 0);
        if (html) parts.push(html);
    }

    return parts.join('');
}

/** @param {ReleaseNoteGroup[]} groups */
function flattenGroups(groups) {
    /** @type {string[]} */
    const bullets = [];
    for (const group of groups) {
        for (const item of group.items) {
            bullets.push(item.body ? `**${item.title}** ${item.body}` : `**${item.title}**`);
        }
        bullets.push(...flattenGroups(group.children));
    }
    return bullets;
}

/** @deprecated Use parseReleaseNotes — kept for scripts that expect flat bullets. */
export function parseChangelogBullets(markdown, version) {
    const { summary, groups } = parseReleaseNotes(markdown, version);
    const bullets = [];
    if (summary) bullets.push(summary.body ? `**${summary.title}** ${summary.body}` : `**${summary.title}**`);
    bullets.push(...flattenGroups(groups));
    return bullets;
}

export function getReleaseNotesForVersion(version) {
    return parseReleaseNotes(changelogMarkdown, version);
}

/**
 * @param {string} version
 * @returns {Promise<ParsedReleaseNotes>}
 */
export async function resolveReleaseNotesForVersion(version) {
    const local = getReleaseNotesForVersion(version);
    if (releaseNotesHasContent(local)) return local;

    for (const baseUrl of REMOTE_CHANGELOG_URLS) {
        try {
            const res = await fetch(`${baseUrl}?t=${Date.now()}`);
            if (!res.ok) continue;
            const remote = parseReleaseNotes(await res.text(), version);
            if (releaseNotesHasContent(remote)) return remote;
        } catch {
            /* try next source */
        }
    }
    return { summary: null, groups: [] };
}
