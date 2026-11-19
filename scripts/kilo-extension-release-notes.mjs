#!/usr/bin/env node
/**
 * Compose and write one changelog section per extension store release.
 *
 * The Extension Store Release workflow writes the section for the version it
 * built into the version-bump PR that follows it. `body` lists the merged pull
 * requests that touched the extension between two refs, and `write` inserts the
 * section above the newest one in apps/extension/CHANGELOG.md.
 *
 * The listed paths are what the store build bundles: the extension itself plus
 * the workspace packages its sources allowlist in apps/extension/wxt.config.ts
 * names. A change to a bundled package is a change the user receives, so it is
 * part of the release. Everything a build never reads is excluded: the
 * changelog, documentation, tests, build tooling and check configs. A commit
 * that touches only those must never be its own release reason.
 *
 * Usage:
 *   node scripts/kilo-extension-release-notes.mjs body [--from <ref>] [--to <ref>]
 *   node scripts/kilo-extension-release-notes.mjs write --heading <line> --body-file <path> [--changelog <repo path>]
 *
 * `--changelog` is repository-relative (default apps/extension/CHANGELOG.md);
 * `--body-file` is relative to the current directory.
 *
 * Exit codes:
 *   0 - the body was printed, or the section was written or was already present
 *   1 - the body file or the changelog cannot be read
 *   2 - usage error, or a --from or --to ref that does not resolve
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  composeSection,
  hasSectionHeading,
  insertSection,
  isPullRequestSubject,
  linkPullRequest,
  readBodyLines,
} from './kilo-app-release-notes.mjs';

export const CHANGELOG = 'apps/extension/CHANGELOG.md';

// What the store build ships: the extension plus the sources of every workspace
// package its bundle carries. Keep the packages in step with the
// `packages/*/src/**` entries of includeSources in apps/extension/wxt.config.ts.
// Only sources ship, so a change to a package's manifests, tests or tooling is
// not a release reason.
export const NOTES_PATHS = [
  'apps/extension/',
  'packages/app-shared/src/',
  'packages/cloud-agent-sdk/src/',
  'packages/session-ingest-contracts/src/',
];

// The extension-local files that never reach the built zip: documentation,
// tests, build tooling and the configs of the checks. They are not a shipped
// change, so a commit that touches only them must not reach the notes of the
// next build either.
export const EXTENSION_LOCAL_EXCLUDES = [
  ':(exclude,glob)apps/extension/**/*.md',
  ':(exclude,glob)apps/extension/**/*.test.ts',
  ':(exclude,glob)apps/extension/**/*.test.tsx',
  ':(exclude,glob)apps/extension/tests/**',
  ':(exclude,glob)apps/extension/scripts/**',
  ':(exclude)apps/extension/.gitignore',
  ':(exclude,glob)apps/extension/.oxlintrc*.json',
  ':(exclude,glob)apps/extension/vitest*.ts',
  ':(exclude)apps/extension/playwright.config.ts',
  ':(exclude)apps/extension/tsconfig.json',
  ':(exclude,glob)packages/*/src/**/*.test.ts',
];

const CHANGELOG_EXCLUDE = `:(exclude)${CHANGELOG}`;

// The bump PR carries no product change, so it must not appear in the section
// of the release that follows it.
const BUMP_SUBJECT_RE = /^chore\(extension\): bump version to /;

export const INITIAL_MARKER = '- First tracked release: no earlier release tag to compare against.';
// A release happens only when a store build was requested. With no extension
// pull request in the range, only direct commits and dependency updates landed.
export const NO_PULL_REQUEST_MARKER = '- No extension pull request since the previous release.';

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...options });
}

function resolveRef(ref) {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function repoRoot() {
  try {
    return git(['rev-parse', '--show-toplevel']).trim();
  } catch {
    return process.cwd();
  }
}

/** The body lines for a release: one linked line per shipped pull request. */
export function bodyLines(subjects) {
  const shipped = subjects.filter(
    subject => !BUMP_SUBJECT_RE.test(subject) && isPullRequestSubject(subject)
  );
  if (shipped.length === 0) {
    return [NO_PULL_REQUEST_MARKER];
  }
  return shipped.map(subject => `- ${linkPullRequest(subject)}`);
}

/**
 * The changelog text with the new section above the newest one, or null when
 * the heading is already there. A file that holds no section yet gets a blank
 * line after its header, so the first section is never glued to the prose.
 */
export function changelogWith(content, heading, section) {
  if (hasSectionHeading(content, heading)) {
    return null;
  }
  const hasSection = /(?:^|\n)## /.test(content);
  const base = hasSection ? content : `${content.replace(/\n*$/, '')}\n\n`;
  return insertSection(base, section);
}

function fail(message) {
  console.error(`changelog: ${message}`);
  return 1;
}

function usage(message) {
  if (message) {
    console.error(`changelog: ${message}`);
  }
  console.error('Usage:');
  console.error('  node scripts/kilo-extension-release-notes.mjs body [--from <ref>] [--to <ref>]');
  console.error(
    '  node scripts/kilo-extension-release-notes.mjs write --heading <line> --body-file <path> [--changelog <repo path>]'
  );
  return 2;
}

function parseArgs(args, names) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index].replace(/^--/, '');
    if (!args[index].startsWith('--') || !names.includes(name)) {
      return { error: `unknown argument: ${args[index]}` };
    }
    options[name] = args[(index += 1)];
    if (options[name] === undefined) {
      return { error: `${args[index - 1]} needs a value` };
    }
  }
  return { options };
}

function runBody(args) {
  const { options, error } = parseArgs(args, ['from', 'to']);
  if (error) {
    return usage(error);
  }
  if (options.to && !options.from) {
    return usage('--to needs --from: the section spans two releases');
  }
  if (!options.from) {
    console.log(INITIAL_MARKER);
    return 0;
  }
  if (!resolveRef(options.from)) {
    return usage(`--from ref does not resolve: ${options.from}`);
  }
  if (options.to && !resolveRef(options.to)) {
    return usage(`--to ref does not resolve: ${options.to}`);
  }
  const log = git([
    'log',
    '--reverse',
    '--format=%s',
    `${options.from}..${options.to ?? 'HEAD'}`,
    '--',
    ...NOTES_PATHS,
    CHANGELOG_EXCLUDE,
    ...EXTENSION_LOCAL_EXCLUDES,
  ]);
  for (const line of bodyLines(log.split('\n').filter(Boolean))) {
    console.log(line);
  }
  return 0;
}

function runWrite(args) {
  const { options, error } = parseArgs(args, ['heading', 'body-file', 'changelog']);
  if (error) {
    return usage(error);
  }
  const heading = options.heading;
  if (!heading || !heading.startsWith('## ') || heading.includes('\n')) {
    return usage('write requires a one-line --heading that starts with "## "');
  }
  if (!options['body-file']) {
    return usage('write requires --body-file');
  }

  let bodyText;
  try {
    bodyText = readFileSync(options['body-file'], 'utf8');
  } catch (readError) {
    return fail(`cannot read --body-file ${options['body-file']}: ${readError.message}`);
  }

  const changelogPath = resolve(repoRoot(), options.changelog ?? CHANGELOG);
  if (!existsSync(changelogPath)) {
    return fail(`no changelog at ${changelogPath}`);
  }
  const content = readFileSync(changelogPath, 'utf8');
  const text = changelogWith(content, heading, composeSection(heading, readBodyLines(bodyText)));
  if (text === null) {
    console.log(`changelog: ${heading} already present`);
    return 0;
  }
  writeFileSync(changelogPath, text);
  console.log(`changelog: wrote ${heading}`);
  return 0;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'body') {
    return runBody(args);
  }
  if (command === 'write') {
    return runWrite(args);
  }
  return usage();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
