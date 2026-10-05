#!/usr/bin/env node
/**
 * Compose and land one changelog section per kilo-mcp production release.
 *
 * The kilo-mcp Release workflow runs after a production deploy changed the
 * kilo-mcp bundle. `body` lists the merged pull requests that touched
 * services/kilo-mcp between two refs, and `land` writes the section into
 * services/kilo-mcp/CHANGELOG.md on the changelog branch, which one reusable
 * pull request takes to main.
 *
 * Usage:
 *   node scripts/kilo-mcp-release-notes.mjs body [--from <ref>] [--to <ref>]
 *   node scripts/kilo-mcp-release-notes.mjs land --heading <line> --body-file <path> [--branch <name>] [--remote <name>] [--base <branch>]
 *
 * `land` always rebuilds the changelog branch as one commit on the newest
 * base branch. The commit carries the base changelog, every section the branch
 * holds that the base does not, and the new section above them. A merged
 * changelog pull request therefore never loses a section, and the open one
 * never conflicts with main. The push is a compare-and-swap on the branch tip
 * it read, so a branch that moved or was deleted meanwhile is read again.
 *
 * Exit codes:
 *   0 - the section was landed, or was already present
 *   1 - the base has no changelog, or every land attempt was refused
 *   2 - usage error, or a --from ref that does not resolve
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  commitOn,
  composeSection,
  hasSectionHeading,
  headingOf,
  insertSection,
  isPullRequestSubject,
  linkPullRequest,
  readBodyLines,
  reasonOf,
  splitSections,
} from './kilo-app-release-notes.mjs';

export const CHANGELOG = 'services/kilo-mcp/CHANGELOG.md';
const WORKER_PATH = 'services/kilo-mcp/';
const CHANGELOG_EXCLUDE = `:(exclude)${CHANGELOG}`;
const BRANCH_DEFAULT = 'kilo-mcp-changelog';
const MAX_LAND_ATTEMPTS = 4;

export const INITIAL_MARKER = '- First release: no earlier release to compare against.';
// A release happens only when the bundle changed. With no kilo-mcp pull
// request in the range, a dependency or lockfile update changed it.
export const NO_PULL_REQUEST_MARKER =
  '- No kilo-mcp pull request: a dependency update changed the deployed bundle.';

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

function treeFile(commit, path) {
  try {
    return git(['show', `${commit}:${path}`]);
  } catch {
    return '';
  }
}

/** The body lines for a release: one linked line per shipped pull request. */
export function bodyLines(subjects) {
  const shipped = subjects.filter(isPullRequestSubject);
  if (shipped.length === 0) {
    return [NO_PULL_REQUEST_MARKER];
  }
  return shipped.map(subject => `- ${linkPullRequest(subject)}`);
}

/**
 * The changelog text for `base` plus the new section and every section the
 * branch carries that `base` does not. Returns null when `base` already holds
 * all of them.
 */
export function rebuildChangelog(baseContent, branchContent, heading, section) {
  const carried = splitSections(branchContent).filter(
    item => headingOf(item) !== heading && !hasSectionHeading(baseContent, headingOf(item))
  );
  const block = (hasSectionHeading(baseContent, heading) ? '' : section) + carried.join('');
  return block === '' ? null : insertSection(baseContent, block);
}

function remoteSha(remote, ref) {
  const out = git(['ls-remote', remote, ref]).trim();
  return out === '' ? '' : out.split(/\s+/)[0];
}

function fetchSha(remote, branch) {
  git(['fetch', '--no-tags', remote, `refs/heads/${branch}`]);
  return git(['rev-parse', 'FETCH_HEAD']).trim();
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
  console.error('  node scripts/kilo-mcp-release-notes.mjs body [--from <ref>] [--to <ref>]');
  console.error(
    '  node scripts/kilo-mcp-release-notes.mjs land --heading <line> --body-file <path> [--branch <name>] [--remote <name>] [--base <branch>]'
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
  if (!options.from) {
    console.log(INITIAL_MARKER);
    return 0;
  }
  if (!resolveRef(options.from)) {
    return usage(`--from ref does not resolve: ${options.from}`);
  }
  const log = git([
    'log',
    '--reverse',
    '--format=%s',
    `${options.from}..${options.to ?? 'HEAD'}`,
    '--',
    WORKER_PATH,
    CHANGELOG_EXCLUDE,
  ]);
  for (const line of bodyLines(log.split('\n').filter(Boolean))) {
    console.log(line);
  }
  return 0;
}

function runLand(args) {
  const { options, error } = parseArgs(args, ['heading', 'body-file', 'branch', 'remote', 'base']);
  if (error) {
    return usage(error);
  }
  const heading = options.heading;
  if (!heading || !heading.startsWith('## ') || heading.includes('\n')) {
    return usage('land requires a one-line --heading that starts with "## "');
  }
  if (!options['body-file']) {
    return usage('land requires --body-file');
  }
  const branch = options.branch ?? BRANCH_DEFAULT;
  const remote = options.remote ?? 'origin';
  const base = options.base ?? 'main';

  let bodyText;
  try {
    bodyText = readFileSync(options['body-file'], 'utf8');
  } catch (readError) {
    return fail(`cannot read --body-file ${options['body-file']}: ${readError.message}`);
  }
  const section = composeSection(heading, readBodyLines(bodyText));
  console.log(section.replace(/\n$/, ''));

  let lastFailure = 'unknown error';
  for (let attempt = 1; attempt <= MAX_LAND_ATTEMPTS; attempt += 1) {
    try {
      const baseSha = fetchSha(remote, base);
      const baseContent = treeFile(baseSha, CHANGELOG);
      if (baseContent === '') {
        return fail(`${base} has no ${CHANGELOG}`);
      }
      // An empty sha is the lease for "the branch must not exist yet".
      const branchSha = remoteSha(remote, `refs/heads/${branch}`);
      const branchContent = branchSha === '' ? '' : treeFile(fetchSha(remote, branch), CHANGELOG);
      const content = rebuildChangelog(baseContent, branchContent, heading, section);
      if (content === null) {
        console.log(`changelog: landed ${heading} on ${branch} (already present on ${base})`);
        return 0;
      }
      const sha = commitOn(
        baseSha,
        CHANGELOG,
        content,
        `docs(kilo-mcp): changelog for ${heading.slice(3)}`
      );
      git([
        'push',
        `--force-with-lease=refs/heads/${branch}:${branchSha}`,
        remote,
        `${sha}:refs/heads/${branch}`,
      ]);
      console.log(`changelog: landed ${heading} on ${branch} as ${sha}`);
      return 0;
    } catch (landError) {
      lastFailure = reasonOf(landError);
      console.log(`changelog: attempt ${attempt} rejected (${lastFailure})`);
    }
  }
  return fail(`could not land ${heading} on ${branch} (${lastFailure})`);
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'body') {
    return runBody(args);
  }
  if (command === 'land') {
    return runLand(args);
  }
  return usage();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
