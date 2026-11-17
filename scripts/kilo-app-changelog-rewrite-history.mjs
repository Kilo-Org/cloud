#!/usr/bin/env node
/**
 * Rewrite every already-shipped version in apps/mobile/CHANGELOG.md with the
 * same notes rewrite the Release workflow runs for a new build, so the bundled
 * changelog screen shows curated text for history too.
 *
 * One version is one reader-facing item: the screen already merges the builds
 * of a version, so the rewrite collapses each run of same-version sections onto
 * its newest heading and replaces the older headings' bullets with a line that
 * points there. A section that already carries `### ` groups, or a version
 * whose bullets are all internal work, is left untouched, which makes a second
 * run a no-op.
 *
 * Usage:
 *   node scripts/kilo-app-changelog-rewrite-history.mjs [--changelog <path>]
 *
 * `--changelog` is relative to the current directory (default
 * apps/mobile/CHANGELOG.md). `KILO_CHANGELOG_API_KEY` is required;
 * `KILO_CHANGELOG_BASE_URL` and `KILO_CHANGELOG_TIMEOUT_MS` point the rewrite at
 * a local fake gateway for tests. The file is written even when some versions
 * failed validation, so a second run retries only those, and the run exits 1.
 *
 * Exit codes:
 *   0 - every reader-facing version is curated
 *   1 - the changelog could not be read or written, or a version failed the
 *       rewrite and was left as it was
 *   2 - usage error, or KILO_CHANGELOG_API_KEY is not set
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  changelogBodyLines,
  isNoChangeMarker,
  plainSubject,
  requestCuratedNotes,
  rewriteCandidates,
} from './kilo-app-release-notes.mjs';

const CHANGELOG_DEFAULT = 'apps/mobile/CHANGELOG.md';
const VERSION_PREFIX = /^\d+\.\d+\.\d+/;
const GROUP_HEADING = /^### /m;

/** The file as its maintainer preamble and its `## ` sections, in file order. */
function parseChangelog(text) {
  const first = text.search(/^## /m);
  if (first === -1) {
    return { preamble: text, sections: [] };
  }
  return {
    preamble: text.slice(0, first),
    sections: text
      .slice(first)
      .split(/(?=^## )/m)
      .map(part => part.replace(/\s+$/, ''))
      .filter(part => part.startsWith('## ')),
  };
}

/** `1.0.15` in `## 1.0.15 (build 710 iOS, 711 Android)`; the heading's words otherwise. */
function versionOf(heading) {
  const text = heading.replace(/^##\s+/, '').trim();
  return VERSION_PREFIX.exec(text)?.[0] ?? text;
}

/** The heading line of a section. */
function headingOf(section) {
  return section.split('\n')[0];
}

/** One section rebuilt from a heading and its body lines. */
function sectionText(heading, bodyLines) {
  return bodyLines.length === 0 ? heading : `${heading}\n\n${bodyLines.join('\n')}`;
}

/** The shipped bullets of a flat section, without the no-change markers. */
function bulletsOf(section) {
  return section
    .split('\n')
    .slice(1)
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).trim())
    .filter(bullet => bullet !== '' && !isNoChangeMarker(bullet));
}

/** Consecutive sections of one version, newest build first. */
function versionGroups(sections) {
  const groups = [];
  sections.forEach((section, index) => {
    const version = versionOf(headingOf(section));
    const last = groups[groups.length - 1];
    if (last !== undefined && last.version === version) {
      last.indices.push(index);
    } else {
      groups.push({ version, indices: [index] });
    }
  });
  return groups;
}

/**
 * The rewritten file and the versions that could not be rewritten. A version
 * the screen already reads as curated, or one with nothing a reader can see, is
 * kept byte-for-byte.
 */
async function rewriteSections(parsed, options) {
  const groups = versionGroups(parsed.sections);
  const written = new Map();
  const failures = [];
  let curated = 0;
  let skipped = 0;
  for (const group of groups) {
    const groupSections = group.indices.map(index => parsed.sections[index]);
    if (groupSections.some(section => GROUP_HEADING.test(section))) {
      skipped += 1;
      continue;
    }
    // The screen lists a version's newest feature last in the commit log, which
    // is the oldest build's first line; the rewrite reads the same order.
    const bullets = groupSections
      .slice()
      .reverse()
      .flatMap(section => bulletsOf(section));
    const subjects = bullets.map(plainSubject);
    if (subjects.length === 0 || changelogBodyLines(subjects).length === 0) {
      skipped += 1;
      continue;
    }
    const result = await requestCuratedNotes(rewriteCandidates(subjects), options);
    if (result.error) {
      failures.push(group.version);
      console.error(`changelog: ${group.version}: ${result.error}; left as it was`);
      continue;
    }
    curated += 1;
    const merged = `_Its notes are on the newest ${group.version} section above._`;
    group.indices.forEach((index, position) => {
      written.set(
        index,
        sectionText(headingOf(parsed.sections[index]), position === 0 ? result.lines : [merged])
      );
    });
  }
  const sections = parsed.sections.map((section, index) => written.get(index) ?? section);
  return {
    text: `${parsed.preamble}${sections.length === 0 ? '' : `${sections.join('\n\n')}\n`}`,
    curated,
    skipped,
    failures,
  };
}

function usage(message) {
  if (message) {
    console.error(`changelog: ${message}`);
  }
  console.error('Usage:');
  console.error('  node scripts/kilo-app-changelog-rewrite-history.mjs [--changelog <path>]');
  return 2;
}

async function main() {
  const args = process.argv.slice(2);
  let changelog = CHANGELOG_DEFAULT;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--changelog') {
      changelog = args[(index += 1)];
    } else {
      return usage(`unknown argument: ${arg}`);
    }
  }
  if (!process.env.KILO_CHANGELOG_API_KEY) {
    return usage('KILO_CHANGELOG_API_KEY is required to rewrite the shipped notes');
  }

  const path = resolve(changelog);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    console.error(`changelog: cannot read ${path}: ${error.message}`);
    return 1;
  }
  const parsed = parseChangelog(text);
  const rewritten = await rewriteSections(parsed, {});
  if (rewritten.text !== text) {
    writeFileSync(path, rewritten.text);
  }
  console.log(
    `changelog: curated ${rewritten.curated} version(s), left ${rewritten.skipped} as they were (${path})`
  );
  if (rewritten.failures.length > 0) {
    console.error(
      `changelog: ${rewritten.failures.length} version(s) still need the rewrite: ${rewritten.failures.join(', ')}`
    );
    return 1;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
