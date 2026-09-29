#!/usr/bin/env node
/**
 * Compose and land one changelog section per kilo-app store build.
 *
 * The kilo-app Release workflow writes the section after a successful store
 * submission. `body` lists the merged pull requests that shipped between two
 * refs, `identity` reads the store build identity from the built IPA, and
 * `write` inserts the section above the newest one and (with --land) pushes it
 * onto a branch.
 *
 * Usage:
 *   node scripts/kilo-app-release-notes.mjs body [--from <ref>] [--to <ref>]
 *   node scripts/kilo-app-release-notes.mjs identity --config <app.config.ts> --ipa <ipa> [--build-json <build.json>]
 *   node scripts/kilo-app-release-notes.mjs write --version <v> --ios-build <n> [--android-build <m>] --body-file <path> [--changelog <repo path>] [--print-only] [--land <remote>:<branch>] [--pending <branch>]
 *
 * `--changelog` is repository-relative (default apps/mobile/CHANGELOG.md).
 * `--config`, `--ipa`, `--build-json` and `--body-file` are relative to the
 * current directory.
 *
 * A `--land` whose branch is gone or cannot be pushed is not a failed build:
 * the composed section is carried to the `--pending` branch and the next build
 * writes it above its own section. The store submission already succeeded, so
 * the run stays green and the changelog line is not lost. A `--pending` branch
 * that exists but cannot be read is never overwritten: the carry is refused
 * instead, so a transient read failure cannot drop the sections it holds. Two
 * runs can carry at the same time, so every write of the pending branch is a
 * compare-and-swap on the commit it read: the run that loses the race re-reads
 * the branch and merges, and a clear only deletes the branch the landed content
 * already incorporated.
 *
 * Exit codes:
 *   0 - the section was composed, written, landed, was already present, or was
 *       carried to the pending branch
 *   1 - the store build identity cannot be resolved (the IPA is unreadable, has
 *       no CFBundleVersion, or disagrees with the configured version; or a
 *       supplied --build-json names no Android build), or the section could be
 *       neither landed nor carried
 *   2 - usage error, or a --from ref that does not resolve
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHANGELOG_DEFAULT = 'apps/mobile/CHANGELOG.md';

// The same app paths the release workflow watches, minus the changelog itself:
// a changelog commit must never be its own release reason.
const APP_PATHS = [
  'apps/mobile/',
  'packages/trpc/',
  'packages/app-shared/',
  'packages/kilo-chat/',
  'packages/kilo-chat-hooks/',
  'packages/event-service/',
  'packages/notifications/',
  'packages/cloud-agent-sdk/',
];
const CHANGELOG_EXCLUDE = ':(exclude)apps/mobile/CHANGELOG.md';

// The only files a squashed version-bump merge may touch. The release workflow
// lands the changelog section on the bump branch, so the merge carries the
// version line and the changelog together.
const VERSION_BUMP_FILES = new Set(['apps/mobile/app.config.ts', 'apps/mobile/CHANGELOG.md']);

const VERSION_RE = /^ {2}version: '([0-9][0-9.]*)',$/m;
const PR_SUBJECT_RE = /\(#\d+\)$/;
const DIFF_CHANGE_RE = /^[+-][^+-]/;
const DIFF_VERSION_RE = /^[+-] {2}version: '/;

const INITIAL_MARKER = '- Initial release: no earlier build to compare against.';
const NO_CHANGES_MARKER = '- No user-visible changes since the previous build.';

const BOT_NAME = 'github-actions[bot]';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
const MAX_LAND_RETRIES = 3;

// The version-bump branch is deleted the moment a human merges its PR (auto
// delete), which can happen while the section is still being composed. A land
// that finds no branch is not a failed build: the composed section is pushed
// here instead, and the next build writes it above its own section. The branch
// is never merged; it only carries sections no changelog has taken yet.
const PENDING_BRANCH_DEFAULT = 'kilo-app-changelog-pending';
const PENDING_FILE = 'apps/mobile/CHANGELOG.pending.md';

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...options });
}

function reasonOf(error) {
  const stderr = error && error.stderr ? String(error.stderr).trim() : '';
  const lines = stderr
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const rejected = lines.find(line => /rejected|non-fast-forward|fetch first/i.test(line));
  return rejected ?? lines[lines.length - 1] ?? (error && error.message) ?? 'unknown error';
}

/** The marketing version from the `version: '<x.y.z>',` line, or null. */
export function parseConfigVersion(configText) {
  const match = configText.match(VERSION_RE);
  return match ? match[1] : null;
}

/** A commit subject is a shipped PR when it ends with `(#<digits>)`. */
export function isPullRequestSubject(subject) {
  return PR_SUBJECT_RE.test(subject);
}

/**
 * A version-bump commit changed only apps/mobile/app.config.ts (plus the
 * changelog section the workflow lands on the same branch, so the squashed
 * merge carries both) and its app.config.ts diff touches no line other than
 * `  version: '...',` - the shape of the guard in
 * .github/workflows/kilo-app-release.yml. Such a commit must not release the
 * same code again.
 */
export function isVersionBumpCommit(changedFiles, diffText) {
  if (!changedFiles.includes('apps/mobile/app.config.ts')) {
    return false;
  }
  if (!changedFiles.every(file => VERSION_BUMP_FILES.has(file))) {
    return false;
  }
  const changed = diffText.split('\n').filter(line => DIFF_CHANGE_RE.test(line));
  return changed.every(line => DIFF_VERSION_RE.test(line));
}

/** The heading a user reads: the store build identity the section describes. */
export function sectionHeading(version, iosBuild, androidBuild) {
  if (androidBuild && androidBuild !== iosBuild) {
    return `## ${version} (build ${iosBuild} iOS, ${androidBuild} Android)`;
  }
  return `## ${version} (build ${iosBuild})`;
}

/** The body-file lines, without the trailing newline the file ends on. */
export function readBodyLines(text) {
  const lines = text.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/** One blank line after the heading, the body, one blank line after it. */
export function composeSection(heading, bodyLines) {
  return `${heading}\n\n${bodyLines.join('\n')}\n\n`;
}

/** True when the changelog already carries this exact heading line. */
export function hasSectionHeading(content, heading) {
  return content.split('\n').some(line => line === heading);
}

/**
 * Split a pending-store text into whole sections, in the order they were
 * stored (newest first, because a new failure is prepended). A section runs
 * from its `## ` heading to the next one, so a carried section keeps the
 * heading a user reads.
 */
export function splitSections(text) {
  return text
    .split(/(?=^## )/m)
    .map(part => part.trim())
    .filter(part => part.startsWith('## '))
    .map(part => `${part}\n\n`);
}

/** The heading line of a section, i.e. its first line. */
function headingOf(section) {
  return section.split('\n')[0];
}

/**
 * Insert the section immediately before the first `## ` line, or at the end
 * when the changelog has no section yet. Every existing line is copied
 * byte-for-byte, so an older section is never rewritten.
 */
export function insertSection(content, section) {
  const match = content.match(/(?:^|\n)## /);
  if (!match) {
    if (content.length === 0 || content.endsWith('\n')) {
      return content + section;
    }
    return `${content}\n${section}`;
  }
  const index = match.index + (match[0].startsWith('\n') ? 1 : 0);
  return content.slice(0, index) + section + content.slice(index);
}

function repoRoot() {
  try {
    return git(['rev-parse', '--show-toplevel']).trim();
  } catch {
    return process.cwd();
  }
}

function resolveRef(ref) {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function changedFilesOf(sha) {
  return git(['show', '--name-only', '--format=', sha])
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function isVersionBump(sha) {
  let files;
  try {
    files = changedFilesOf(sha);
  } catch {
    return false;
  }
  if (!files.includes('apps/mobile/app.config.ts')) {
    return false;
  }
  try {
    const diff = git(['show', '-U0', '--format=', sha, '--', 'apps/mobile/app.config.ts']);
    return isVersionBumpCommit(files, diff);
  } catch {
    return false;
  }
}

/** The shipped PR subjects for `<from>..<to>`, oldest first. */
function shippedSubjects(from, to) {
  const log = git([
    'log',
    '--reverse',
    '--format=%h%x09%s',
    `${from}..${to}`,
    '--',
    ...APP_PATHS,
    CHANGELOG_EXCLUDE,
  ]);
  const subjects = [];
  for (const line of log.split('\n')) {
    if (!line) {
      continue;
    }
    const tab = line.indexOf('\t');
    if (tab < 0) {
      continue;
    }
    const sha = line.slice(0, tab);
    const subject = line.slice(tab + 1);
    if (!isPullRequestSubject(subject) || isVersionBump(sha)) {
      continue;
    }
    subjects.push(subject);
  }
  return subjects;
}

function parseInfoPlist(plistPath) {
  // A signed IPA's Info.plist is binary. Python's plistlib stdlib handles both
  // XML and binary formats and is preinstalled on the ubuntu-latest runner.
  const script = [
    'import plistlib, json, sys',
    'with open(sys.argv[1], "rb") as f:',
    '    data = plistlib.load(f)',
    'json.dump(data, sys.stdout)',
  ].join('\n');
  const out = execFileSync('python3', ['-c', script, plistPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

/** The Info.plist of the .app inside the IPA, or { error } when unreadable. */
function readIpaInfoPlist(ipaPath) {
  const work = mkdtempSync(join(tmpdir(), 'kilo-notes-ipa-'));
  try {
    const extractDir = join(work, 'ipa');
    mkdirSync(extractDir, { recursive: true });
    try {
      execFileSync('unzip', ['-q', '-o', ipaPath, '-d', extractDir], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      return { error: `cannot read --ipa ${ipaPath}: ${reasonOf(error)}` };
    }
    const payloadDir = join(extractDir, 'Payload');
    let appName;
    try {
      appName = readdirSync(payloadDir).find(entry => entry.endsWith('.app'));
    } catch {
      appName = undefined;
    }
    if (!appName) {
      return { error: `--ipa ${ipaPath} has no Payload/*.app bundle` };
    }
    try {
      return parseInfoPlist(join(payloadDir, appName, 'Info.plist'));
    } catch (error) {
      return { error: `cannot read the Info.plist inside ${ipaPath}: ${reasonOf(error)}` };
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The appBuildVersion of the ANDROID entry in build.json: `{ build }` when the
 * file names one, otherwise `{ error }`.
 *
 * The heading this feeds labels both store builds, so a build.json that cannot
 * be read, has no ANDROID entry, or carries no appBuildVersion for it is an
 * identity error: returning '' would let the run succeed with an empty Android
 * build number and the changelog would credit the Android submission to no
 * build at all.
 */
function androidBuildFrom(buildJsonPath) {
  let builds;
  try {
    builds = JSON.parse(readFileSync(buildJsonPath, 'utf8'));
  } catch (error) {
    return { error: `cannot read ${buildJsonPath}: ${reasonOf(error)}` };
  }
  if (!Array.isArray(builds)) {
    return { error: `${buildJsonPath} is not a JSON array of build objects` };
  }
  const android = builds.find(build => build && build.platform === 'ANDROID');
  if (!android) {
    return { error: `${buildJsonPath} has no ANDROID build` };
  }
  const build = String(android.appBuildVersion ?? android.metadata?.appBuildVersion ?? '');
  if (!build) {
    return {
      error: `the ANDROID build in ${buildJsonPath} has no appBuildVersion`,
    };
  }
  return { build };
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
  console.error('  node scripts/kilo-app-release-notes.mjs body [--from <ref>] [--to <ref>]');
  console.error(
    '  node scripts/kilo-app-release-notes.mjs identity --config <app.config.ts> --ipa <ipa> [--build-json <build.json>]'
  );
  console.error(
    '  node scripts/kilo-app-release-notes.mjs write --version <v> --ios-build <n> [--android-build <m>] --body-file <path> [--changelog <repo path>] [--print-only] [--land <remote>:<branch>] [--pending <branch>]'
  );
  return 2;
}

function runBody(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--from') {
      options.from = args[(index += 1)];
    } else if (arg === '--to') {
      options.to = args[(index += 1)];
    } else {
      return usage(`unknown argument: ${arg}`);
    }
  }
  if (!options.from) {
    console.log(INITIAL_MARKER);
    return 0;
  }
  if (!resolveRef(options.from)) {
    return usage(`--from ref does not resolve: ${options.from}`);
  }
  const subjects = shippedSubjects(options.from, options.to ?? 'HEAD');
  if (subjects.length === 0) {
    console.log(NO_CHANGES_MARKER);
    return 0;
  }
  for (const subject of subjects) {
    console.log(`- ${subject}`);
  }
  return 0;
}

function runIdentity(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--config') {
      options.config = args[(index += 1)];
    } else if (arg === '--ipa') {
      options.ipa = args[(index += 1)];
    } else if (arg === '--build-json') {
      options.buildJson = args[(index += 1)];
    } else {
      return usage(`unknown argument: ${arg}`);
    }
  }
  if (!options.config || !options.ipa) {
    return usage('identity requires --config and --ipa');
  }

  let configText;
  try {
    configText = readFileSync(options.config, 'utf8');
  } catch (error) {
    return fail(`cannot read --config ${options.config}: ${reasonOf(error)}`);
  }
  const version = parseConfigVersion(configText);
  if (!version) {
    return fail(`cannot read the version line from ${options.config}`);
  }

  const plist = readIpaInfoPlist(options.ipa);
  if (plist.error) {
    return fail(plist.error);
  }
  const iosBuild = plist.CFBundleVersion;
  if (!iosBuild) {
    return fail(`--ipa ${options.ipa} has no CFBundleVersion in its Info.plist`);
  }
  const shortVersion = plist.CFBundleShortVersionString;
  if (shortVersion !== version) {
    return fail(
      `--ipa ${options.ipa} carries CFBundleShortVersionString "${shortVersion ?? 'missing'}", not the configured version "${version}"`
    );
  }

  // The heading and the store identity both promise the Android build number:
  // fail before the submission rather than label the run with `unknown`.
  let androidBuild = '';
  if (options.buildJson) {
    const android = androidBuildFrom(options.buildJson);
    if (android.error) {
      return fail(android.error);
    }
    androidBuild = android.build;
  }
  process.stdout.write(`version=${version}\n`);
  process.stdout.write(`kilo-app marketing version ${version} (${options.config})\n`);
  process.stdout.write(`ios_build=${iosBuild}\n`);
  process.stdout.write(`iOS store build ${iosBuild} (CFBundleVersion from the IPA)\n`);
  process.stdout.write(`android_build=${androidBuild}\n`);
  process.stdout.write(
    `Android store build ${androidBuild || 'unknown'} (appBuildVersion from build.json)\n`
  );
  return 0;
}

function treeFile(parent, path) {
  try {
    return git(['show', `${parent}:${path}`]);
  } catch {
    return '';
  }
}

/** A commit on top of `parent` that replaces one file with `content`. */
function commitOn(parent, path, content, message) {
  const blob = git(['hash-object', '-w', '--stdin'], { input: content }).trim();
  const work = mkdtempSync(join(tmpdir(), 'kilo-notes-commit-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(work, 'index') };
    git(['read-tree', parent], { env });
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env });
    const tree = git(['write-tree'], { env }).trim();
    return git(
      [
        '-c',
        `user.name=${BOT_NAME}`,
        '-c',
        `user.email=${BOT_EMAIL}`,
        'commit-tree',
        tree,
        '-p',
        parent,
        '-m',
        message,
      ],
      { env }
    ).trim();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** True when a fetch failed because the ref does not exist on the remote. */
function isMissingRef(error) {
  const stderr = error && error.stderr ? String(error.stderr) : '';
  return /couldn't find remote ref/i.test(stderr);
}

/**
 * The sections carried by the pending branch, newest first, and the commit they
 * were read from. `{ sections: [] }` when the branch holds none, and a branch
 * that does not exist yet is not an error. Any other read failure is
 * `{ sections: [], error }`: it is not the same as "no carried sections", and
 * the carry path writes the branch, so overwriting content that could not be
 * read would drop those sections for ever.
 *
 * `sha` is the pending tip those sections were read from. Every write of the
 * branch is a compare-and-swap on it, so two runs that carry at the same time
 * cannot overwrite each other: the writer that lost the race is refused and
 * re-reads instead. `sha` is undefined when the branch does not exist, which the
 * write path passes on as "must still not exist".
 */
function readPending(remote, branch) {
  if (!branch) {
    return { sections: [] };
  }
  try {
    git(['fetch', '--depth=1', remote, branch], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (isMissingRef(error)) {
      return { sections: [] };
    }
    return { sections: [], error: reasonOf(error) };
  }
  const sha = git(['rev-parse', 'FETCH_HEAD']).trim();
  try {
    return { sections: splitSections(git(['show', `FETCH_HEAD:${PENDING_FILE}`])), sha };
  } catch (error) {
    const stderr = error && error.stderr ? String(error.stderr) : '';
    if (/does not exist in/i.test(stderr)) {
      return { sections: [], sha };
    }
    return { sections: [], error: reasonOf(error) };
  }
}

/**
 * Replace the pending branch with `sections`, newest first.
 *
 * `expectedSha` is the pending tip the sections were read from. The push is a
 * compare-and-swap on it, so a branch that advanced after that read is refused
 * rather than overwritten: a concurrent carry that landed in the meantime keeps
 * its section. `undefined` means the branch must still not exist.
 */
function writePending(remote, branch, sections, expectedSha) {
  const blob = git(['hash-object', '-w', '--stdin'], { input: sections.join('') }).trim();
  const work = mkdtempSync(join(tmpdir(), 'kilo-notes-pending-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(work, 'index') };
    git(['read-tree', '--empty'], { env });
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},${PENDING_FILE}`], { env });
    const tree = git(['write-tree'], { env }).trim();
    const sha = git(
      [
        '-c',
        `user.name=${BOT_NAME}`,
        '-c',
        `user.email=${BOT_EMAIL}`,
        'commit-tree',
        tree,
        '-m',
        `chore(kilo-app): ${sections.length} changelog section(s) waiting for a branch`,
      ],
      { env }
    ).trim();
    git(
      [
        'push',
        `--force-with-lease=refs/heads/${branch}:${expectedSha ?? ''}`,
        remote,
        `${sha}:refs/heads/${branch}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return sha;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Drop the pending branch once its sections are in the changelog.
 *
 * `expectedSha` is the pending tip whose sections the landed content already
 * carries. The delete is a compare-and-swap on it, so a carry that landed after
 * that read stays on the branch for the next build instead of being deleted
 * with the sections this run incorporated.
 */
function clearPending(remote, branch, expectedSha) {
  try {
    git(
      [
        'push',
        `--force-with-lease=refs/heads/${branch}:${expectedSha ?? ''}`,
        remote,
        `:refs/heads/${branch}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch {
    // A stale pending branch is cosmetic: its sections are already in the
    // changelog, the next land re-reads the branch, and only the sections the
    // changelog does not already carry are written again.
  }
}

function landSection(options, heading, section) {
  const separator = options.land.lastIndexOf(':');
  const remote = options.land.slice(0, separator);
  const branch = options.land.slice(separator + 1);
  if (separator < 0 || !remote || !branch) {
    return usage(`--land must be <remote>:<branch>, got ${options.land}`);
  }

  const message = `docs(kilo-app): changelog for ${options.version} (build ${options.iosBuild})`;
  console.log(section.replace(/\n$/, ''));

  // Sections an earlier build could not land ride along above their own, so a
  // branch that was merged during that build never loses its changelog line.
  // A pending branch that exists but cannot be read is not an empty one: the
  // carry path below replaces the branch, and overwriting content that could
  // not be read would drop the sections an earlier build carried there.
  const pendingRead = readPending(remote, options.pending);
  const pending = pendingRead.sections;

  for (let attempt = 1; attempt <= MAX_LAND_RETRIES + 1; attempt += 1) {
    try {
      git(['fetch', remote, branch]);
    } catch (error) {
      console.log(`changelog: attempt ${attempt} rejected (${reasonOf(error)})`);
      continue;
    }
    const parent = git(['rev-parse', 'FETCH_HEAD']).trim();
    const content = treeFile(parent, options.changelog);
    // A re-run of a build whose section was carried would otherwise write it
    // twice: drop a carried section that names this build.
    const carried = pending.filter(
      item => headingOf(item) !== heading && !hasSectionHeading(content, headingOf(item))
    );
    const block = hasSectionHeading(content, heading)
      ? carried.join('')
      : section + carried.join('');
    if (block === '') {
      console.log(`changelog: landed ${heading} on ${branch} (already present)`);
      if (pending.length > 0) {
        clearPending(remote, options.pending, pendingRead.sha);
      }
      return 0;
    }
    const sha = commitOn(parent, options.changelog, insertSection(content, block), message);
    try {
      git(['push', remote, `${sha}:refs/heads/${branch}`]);
      console.log(`changelog: landed ${heading} on ${branch} as ${sha}`);
      if (pending.length > 0) {
        clearPending(remote, options.pending, pendingRead.sha);
      }
      return 0;
    } catch (error) {
      console.log(`changelog: attempt ${attempt} rejected (${reasonOf(error)})`);
    }
  }

  // The branch was merged and deleted while the build ran. The submission
  // already succeeded, so the run stays green: the section waits for the next
  // build's section instead of being lost.
  if (pendingRead.error) {
    return fail(
      `could not land ${heading} on ${branch}, and ${options.pending} could not be read (${pendingRead.error}); refusing to overwrite the sections it carries`
    );
  }

  // Two runs can fail to land at the same time. Each one carries the sections it
  // read, and its write is a compare-and-swap on that read, so the run that
  // loses the race is refused and re-reads the branch instead of overwriting the
  // section the other run just carried there.
  let snapshot = pendingRead;
  let carryFailure = 'unknown error';
  for (let attempt = 1; attempt <= MAX_LAND_RETRIES + 1; attempt += 1) {
    try {
      writePending(
        remote,
        options.pending,
        [section, ...snapshot.sections.filter(item => headingOf(item) !== heading)],
        snapshot.sha
      );
      console.log(
        `changelog: pending ${heading} carried to ${options.pending}; the next build writes it above its own section`
      );
      return 0;
    } catch (error) {
      carryFailure = reasonOf(error);
      const reread = readPending(remote, options.pending);
      if (reread.error) {
        return fail(
          `could not carry ${heading} to ${options.pending} (${carryFailure}), and it could not be re-read (${reread.error}); refusing to overwrite the sections it carries`
        );
      }
      snapshot = reread;
    }
  }
  return fail(
    `could not land ${heading} on ${branch} or carry it to ${options.pending} (${carryFailure})`
  );
}

function runWrite(args) {
  const options = { changelog: CHANGELOG_DEFAULT, pending: PENDING_BRANCH_DEFAULT };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--version') {
      options.version = args[(index += 1)];
    } else if (arg === '--ios-build') {
      options.iosBuild = args[(index += 1)];
    } else if (arg === '--android-build') {
      options.androidBuild = args[(index += 1)];
    } else if (arg === '--body-file') {
      options.bodyFile = args[(index += 1)];
    } else if (arg === '--changelog') {
      options.changelog = args[(index += 1)];
    } else if (arg === '--land') {
      options.land = args[(index += 1)];
    } else if (arg === '--pending') {
      options.pending = args[(index += 1)];
    } else if (arg === '--print-only') {
      options.printOnly = true;
    } else {
      return usage(`unknown argument: ${arg}`);
    }
  }
  if (!options.version || !options.iosBuild || !options.bodyFile) {
    return usage('write requires --version, --ios-build and --body-file');
  }

  let bodyText;
  try {
    bodyText = readFileSync(options.bodyFile, 'utf8');
  } catch (error) {
    return fail(`cannot read --body-file ${options.bodyFile}: ${reasonOf(error)}`);
  }
  const heading = sectionHeading(options.version, options.iosBuild, options.androidBuild);
  const section = composeSection(heading, readBodyLines(bodyText));

  if (options.printOnly) {
    process.stdout.write(section);
    return 0;
  }
  if (options.land) {
    return landSection(options, heading, section);
  }

  const changelogPath = resolve(repoRoot(), options.changelog);
  const content = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '';
  if (hasSectionHeading(content, heading)) {
    console.log(`changelog: ${heading} already present`);
    return 0;
  }
  writeFileSync(changelogPath, insertSection(content, section));
  console.log(`changelog: wrote ${heading}`);
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'body') {
    return runBody(argv.slice(1));
  }
  if (argv[0] === 'identity') {
    return runIdentity(argv.slice(1));
  }
  if (argv[0] === 'write') {
    return runWrite(argv.slice(1));
  }
  return usage();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
