#!/usr/bin/env node
/**
 * Build store "What's new" from changelog.md.
 *
 * Copies the version's "This update comes with…" line, then non-Internal
 * sections (headings + bullets) filtered by platform tags. Strips markdown
 * and tags. Legacy ### BY PLATFORM nesting still works.
 *
 *   node scripts/changelog-to-store-whats-new.js <version> --platform windows|macos|ios|android [--empty-ok] [--out file]
 */

const fs = require('fs');
const path = require('path');

const GITHUB_REPO_URL = 'https://github.com/digitalhabits/dh-blocker';
const DEFAULT_INTRO = 'This update comes with some helpful improvements.';
const PLATFORM_TAG_RE = /^\[(desktop|macos|windows|ios|android)\]\s*/i;

const MAX_CHARS = { windows: 10000, macos: 10000, mac: 10000, ios: 4000, android: 4000 };

function usage() {
  console.error(
    'usage: node scripts/changelog-to-store-whats-new.js <version> [changelog.md] --platform windows|macos|ios|android [--empty-ok] [--out file]',
  );
  process.exit(1);
}

function normalizePlatform(raw) {
  const p = (raw || '').toLowerCase();
  if (p === 'mac' || p === 'macos' || p === 'osx') return 'macos';
  if (p === 'win' || p === 'windows') return 'windows';
  if (p === 'ios' || p === 'android') return p;
  return null;
}

function extractSection(changelog, version) {
  const tag = version.startsWith('v') ? version : `v${version}`;
  const headingRe = new RegExp(`^## ${tag.replace(/\./g, '\\.')}\\s*$`);
  const lines = changelog.split(/\r?\n/);
  let found = false;
  const section = [];
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      if (found) break;
      if (headingRe.test(line)) {
        found = true;
        continue;
      }
    }
    if (found) section.push(line);
  }
  if (!found || section.every((l) => !l.trim())) {
    throw new Error(`No changelog section for ${tag} — add ## ${tag} first.`);
  }
  return section;
}

function stripMdInline(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*([^*\s][^*]*?)\*/g, '$1')
    .trim();
}

function extractUpdateIntro(sectionLines) {
  const parts = [];
  for (const raw of sectionLines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      if (parts.length) break;
      continue;
    }
    if (/^#{3,6}\s+/.test(line) || /^\s*[-*]\s+/.test(line)) break;
    if (/^>\s*/.test(line)) continue;
    parts.push(stripMdInline(line));
  }
  return parts.join(' ').trim() || DEFAULT_INTRO;
}

function takePlatformTags(rawBody) {
  let rest = String(rawBody || '').trim();
  const tags = [];
  let match = rest.match(PLATFORM_TAG_RE);
  while (match) {
    tags.push(match[1].toLowerCase());
    rest = rest.slice(match[0].length).trim();
    match = rest.match(PLATFORM_TAG_RE);
  }
  return { tags, rest };
}

function tagsMatchPlatform(tags, platform) {
  if (!tags.length) return true;
  if (tags.includes(platform)) return true;
  return (platform === 'windows' || platform === 'macos') && tags.includes('desktop');
}

function isInternalHeading(title) {
  return /^internal\b/i.test(String(title || '').trim());
}

function scopeForHeading(level, title, current) {
  if (level === 3) {
    if (isInternalHeading(title)) return 'internal';
    return /by platform/i.test(title) ? 'by-platform' : 'shared';
  }
  if (current === 'internal') return 'internal';
  const t = title;
  if (/\bios\b/i.test(t)) return 'ios';
  if (/android/i.test(t)) return 'android';
  if (/desktop/i.test(t)) return 'desktop';
  if (/macos|\bmac\b/i.test(t)) return 'macos';
  if (/windows|\bwin\b/i.test(t)) return 'windows';
  if (level === 4) return current === 'by-platform' ? 'by-platform' : 'shared';
  return current;
}

function legacyScopeMatchesPlatform(scope, platform) {
  if (scope === 'shared') return true;
  if (scope === 'internal' || scope === 'by-platform') return false;
  if (platform === 'ios') return scope === 'ios';
  if (platform === 'android') return scope === 'android';
  if (platform === 'windows') return scope === 'desktop' || scope === 'windows';
  if (platform === 'macos') return scope === 'desktop' || scope === 'macos';
  return false;
}

function readContinuedBullet(lines, startIndex, first) {
  let body = first;
  let i = startIndex;
  while (i + 1 < lines.length) {
    const next = lines[i + 1];
    if (
      /^\s{2,}\S/.test(next) &&
      !/^\s*[-*]\s+/.test(next) &&
      !/^#{2,6}\s+/.test(next.trim())
    ) {
      body = `${body} ${next.trim()}`;
      i += 1;
      continue;
    }
    break;
  }
  return { body, index: i };
}

function collectStoreSections(sectionLines, platform) {
  const sections = [];
  let current = null;
  let scope = 'shared';
  let skipHeading = false;

  const startSection = (heading) => {
    current = { heading, bullets: [] };
    sections.push(current);
  };

  for (let i = 0; i < sectionLines.length; i += 1) {
    const line = sectionLines[i].replace(/\s+$/, '');
    if (/^>\s*/.test(line)) continue;

    const heading = line.match(/^(#{3,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();
      scope = scopeForHeading(level, title, scope);
      if (level === 3) {
        skipHeading = isInternalHeading(title) || /by platform/i.test(title);
        current = skipHeading ? null : (startSection(title), current);
      } else if (!skipHeading && scope !== 'internal' && scope !== 'by-platform') {
        current = legacyScopeMatchesPlatform(scope, platform)
          ? (startSection(title), current)
          : null;
      } else {
        current = null;
      }
      continue;
    }
    if (/^#{2,6}\s+/.test(line)) continue;

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (!bullet) continue;

    const cont = readContinuedBullet(sectionLines, i, bullet[1]);
    i = cont.index;
    if (scope === 'internal') continue;

    const { tags, rest } = takePlatformTags(cont.body);
    if (tags.length) {
      if (!tagsMatchPlatform(tags, platform)) continue;
    } else if (!legacyScopeMatchesPlatform(scope, platform)) {
      continue;
    }

    const plain = stripMdInline(rest);
    if (!plain || /^version:\s*/i.test(plain)) continue;

    if (!current) startSection(null);
    current.bullets.push(`- ${plain}`);
  }

  return sections.filter((s) => s.bullets.length > 0);
}

function formatSectionBlocks(sections) {
  return sections
    .map((s) => [s.heading, ...s.bullets].filter(Boolean).join('\n'))
    .join('\n\n');
}

function buildWhatsNew(updateIntro, sections, maxChars, emptyOk) {
  if (!sections.length) {
    if (emptyOk) return '';
    throw new Error(
      'No user-facing changelog bullets for Store notes (only other-platform / Internal lines?).',
    );
  }

  const head = `Hi folks,\n\n${updateIntro}\n\n`;
  const foot = `\n\nRemember that the app is open source — keep your feedback and suggestions coming at ${GITHUB_REPO_URL}\n\nCheers,\nUlrik & all of us at Centre for Digital Habits`;
  let list = formatSectionBlocks(sections);
  const full = `${head}${list}${foot}`;
  if (full.length <= maxChars) return full.trim();

  const budget = maxChars - head.length - foot.length - 1;
  list = `${list.slice(0, Math.max(40, budget - 1)).replace(/\s+\S*$/, '')}…`;
  return `${head}${list}${foot}`.trim();
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length) usage();

  let outPath = null;
  let platform = null;
  let emptyOk = false;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') {
      outPath = args[++i];
      if (!outPath) usage();
    } else if (args[i] === '--empty-ok') {
      emptyOk = true;
    } else if (args[i] === '--platform') {
      platform = normalizePlatform(args[++i]);
      if (!platform) usage();
    } else {
      positional.push(args[i]);
    }
  }

  if (!platform) platform = 'windows';
  const version = positional[0];
  if (!version) usage();

  const changelogPath = path.resolve(positional[1] || 'changelog.md');
  const sectionLines = extractSection(fs.readFileSync(changelogPath, 'utf8'), version);
  const text = buildWhatsNew(
    extractUpdateIntro(sectionLines),
    collectStoreSections(sectionLines, platform),
    MAX_CHARS[platform],
    emptyOk,
  );

  if (outPath) {
    fs.writeFileSync(outPath, text ? `${text}\n` : '', 'utf8');
    console.error(
      text
        ? `Wrote ${outPath} (${text.length} chars, platform=${platform})`
        : `Wrote ${outPath} (empty — no ${platform}-facing changes)`,
    );
  } else {
    process.stdout.write(text ? `${text}\n` : '');
  }
}

main();
