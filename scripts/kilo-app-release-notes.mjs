#!/usr/bin/env node
/**
 * Compose and land one changelog section per kilo-app store build.
 *
 * The kilo-app Release workflow writes the section after a successful store
 * submission. `body` lists the merged pull requests that shipped between two
 * refs, keeps the ones a reader can see, and asks the Kilo gateway to rewrite
 * them as user outcomes; `identity` reads the store build identity from the
 * built IPA, and `write` inserts the section above the newest one and (with
 * --land) pushes it onto a branch.
 *
 * The rewrite is optional. `KILO_CHANGELOG_API_KEY` carries the gateway
 * credential (the release workflow mints a one-hour token for it from the
 * existing `MCP_CATALOG_TOKEN_SECRET` shared secret), and without it - or when
 * the call fails or its answer does not pass `validateCuratedNotes` - `body`
 * prints the deterministic block and warns on stderr. A release never fails
 * because its notes could not be rewritten.
 * `KILO_CHANGELOG_BASE_URL` and `KILO_CHANGELOG_TIMEOUT_MS` exist for tests.
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
 * A `--land` verifies the branch before it writes onto it: a merge base with
 * main must exist, and the branch's diff from that base must be the version
 * line and the changelog only. An empty diff carries no version line, so it is
 * refused too. A branch that fails the check receives nothing, the section is
 * carried to the `--pending` branch so the finished build's line is not lost,
 * and the run exits 1; every later run refuses the same branch until a human
 * removes it. A branch that could not be read - a deleted ref, a failed fetch -
 * is not a verdict on its shape: the attempt is retried, and when the retries
 * run out the section is carried exactly as for a gone branch and the run stays
 * green. A land that succeeds prints two lines after its `changelog: landed
 * ...` line, which the release workflow parses:
 *
 *   changelog-head=<sha the section now sits on>
 *   changelog-files=<the files that commit changes, comma separated>
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
 *       supplied --build-json names no Android build), the version-bump branch
 *       failed the land-time check, or the section could be neither landed nor
 *       carried
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

// The product areas the reader-facing notes name, and the commit scopes that
// map to them. One file, shared with the bundled screen
// (`apps/mobile/src/components/changelog-sections.ts`), so a scope added here
// reaches both the composed section and the sections that already shipped.
const AREA_MAP_PATH = new URL(
  '../apps/mobile/src/components/changelog-areas.json',
  import.meta.url
);
const AREA_MAP = JSON.parse(readFileSync(AREA_MAP_PATH, 'utf8'));

// How many features one section lists; the rest ship their note in the areas
// line, which the screen and this composer cap identically.
const NEW_SUBJECT_LIMIT = 6;

// The repository the app commits ship in. A changelog line links its pull
// request here, so a reader opens the pull request from the rendered file.
const REPO_URL = 'https://github.com/Kilo-Org/cloud';

// The same app paths the release workflow watches, minus the changelog itself:
// a changelog commit must never be its own release reason.
const APP_PATHS = [
  'apps/mobile/',
  'packages/trpc/',
  'packages/app-shared/',
  'packages/event-service/',
  'packages/notifications/',
  'packages/cloud-agent-sdk/',
];
const CHANGELOG_EXCLUDE = ':(exclude)apps/mobile/CHANGELOG.md';

// The app-local files that cannot reach the bundle, exactly as the release
// workflow excludes them from its change detection. They are not a release
// reason there, so a commit that touches only them must not reach the notes of
// the next build either: a test or lint commit is not a shipped change.
export const APP_LOCAL_EXCLUDES = [
  ':(exclude,glob)apps/mobile/**/*.md',
  ':(exclude,glob)apps/mobile/**/*.test.ts',
  ':(exclude,glob)apps/mobile/**/*.test.tsx',
  ':(exclude,glob)apps/mobile/scripts/**',
  ':(exclude,glob)apps/mobile/e2e/**',
  ':(exclude)apps/mobile/.oxlintrc*.json',
  ':(exclude)apps/mobile/vitest*.ts',
];

// The only files a squashed version-bump merge may touch. The release workflow
// lands the changelog section on the bump branch, so the merge carries the
// version line and the changelog together.
const VERSION_BUMP_FILES = new Set(['apps/mobile/app.config.ts', 'apps/mobile/CHANGELOG.md']);

const VERSION_RE = /^ {2}version: '([0-9][0-9.]*)',$/m;
const PR_SUBJECT_RE = /\(#(\d+)\)$/;
const DIFF_CHANGE_RE = /^[+-][^+-]/;
const DIFF_VERSION_RE = /^[+-] {2}version: '/;

const INITIAL_MARKER = '- Initial release: no earlier build to compare against.';
const NO_CHANGES_MARKER = '- No user-visible changes since the previous build.';

const BOT_NAME = 'github-actions[bot]';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
const MAX_LAND_RETRIES = 3;

// Where a version's notes are rewritten. The app serves the OpenAI-compatible
// chat completions shape under `/api/openrouter`, the same route and body the
// agent briefing calls (`apps/web/src/lib/agent-briefing/summary.ts`); both
// prefixes rewrite to the AI gateway's `/api/v1/chat/completions`
// (`apps/web/ai-gateway-rewrites.mjs`).
//
// The model is the gateway alias the app already ships as the agent briefing's
// default (`DEFAULT_BRIEFING_MODEL` in
// apps/web/src/lib/agent-briefing/store.ts:25), so no model is introduced here
// that production does not already serve.
const NOTES_BASE_URL_DEFAULT = 'https://app.kilo.ai';
const NOTES_PATH = '/api/openrouter/chat/completions';
const NOTES_MODEL = '~deepseek/deepseek-flash-latest';

// The completion budget. The alias resolves to a DeepSeek Flash build that
// reasons by default (`deepseek/deepseek-v4.1-flash-1017`: reasoning enabled at
// high effort), and the reasoning tokens are charged to this same cap before
// the answer starts. The briefing grants a reasoning model 16k
// (`REASONING_MAX_OUTPUT_TOKENS` in
// apps/web/src/lib/agent-briefing/summary.ts); a smaller cap is spent on
// thinking, and the empty or half-written content is not JSON.
const NOTES_MAX_TOKENS = 16_384;

// Notes are never worth a delayed release: a call that does not answer within
// this window is abandoned and the deterministic block is written instead. The
// model thinks before it answers, so the window covers a reasoning pass and the
// answer, not one short generation.
const NOTES_TIMEOUT_DEFAULT_MS = 60_000;

// The caps a validated answer has to meet, the same shape the deterministic
// composer and the bundled screen write and read.
const CURATED_NEW_LIMIT = NEW_SUBJECT_LIMIT;
const CURATED_CHANGES_LIMIT = 6;
const CURATED_AREA_LIMIT = 3;
const CURATED_LINE_LIMIT = 160;

// The areas the model may name, from the shared map: `chat`, `cloudAgent`, ...
const CURATED_AREAS = Object.keys(AREA_MAP.areas);

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

export function reasonOf(error) {
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

/** The subject with its trailing `(#<n>)` as a markdown link to the PR. */
export function linkPullRequest(subject) {
  return subject.replace(
    PR_SUBJECT_RE,
    (_, number) => `([#${number}](${REPO_URL}/pull/${number}))`
  );
}

/** `fix(mobile)!: keep the composer` as its type, its scope and its body. */
const CONVENTIONAL_SUBJECT = /^([a-z][a-z-]*)(?:\(([^)]*)\))?!?:\s+(.+)$/;

/**
 * The commit types whose work a reader cannot see in the app. The release
 * workflow already keeps app-local files out of the notes, so this covers the
 * types a shipped file can still carry.
 */
const INTERNAL_SUBJECT_TYPES = ['build', 'chore', 'ci', 'docs', 'refactor', 'style', 'test'];

/**
 * Subjects a reader cannot see a change in even though their commit type ships
 * one: a demo behind a flag, the app's own transport plumbing, and the tweaks
 * that only move a card's padding or drop a section label. The screen applies
 * the same list to sections that already shipped
 * (`apps/mobile/src/components/changelog-sections.ts`).
 */
const UNSEEN_WORK = [
  /\bdemo\b/i,
  /\bflag[- ]gated\b/i,
  /\bnative sync\b/i,
  /\bsocket generation\b/i,
  /\btransport failures?\b/i,
  /\bcard padding\b/i,
  /\bsection label\b/i,
  /^align .*\bpadding\b/i,
];

/**
 * Shipped subjects that name no change in a sentence, dropped until the file
 * they landed in is gone from the app's history.
 */
const UNREADABLE_SUBJECTS = ['answer the request a glanceable approval names'];

// The NEW group policy both this composer and the bundled screen read
// (`apps/mobile/src/components/changelog-sections.ts`): scopes that never reach
// the phone app, subjects that name no phone change, and the leading verbs that
// state a removal or a restriction rather than a feature.
const DROP_SCOPES = new Set(AREA_MAP.newGroup.dropScopes.map(scope => scope.toLowerCase()));
const DROP_SUBJECT_PATTERNS = AREA_MAP.newGroup.dropSubjectPatterns.map(
  pattern => new RegExp(pattern, 'i')
);
const CHANGE_PREFIX = new RegExp(`^(?:${AREA_MAP.newGroup.changePrefixes.join('|')})\\b`, 'i');

/** The area a commit scope names, or the map's generic tag when it names none. */
export function areaOfScope(scope) {
  const key = scope === undefined ? '' : scope.trim().toLowerCase();
  return AREA_MAP.scopeToArea[key] ?? AREA_MAP.generic;
}

/** The areas of `AREAS`, in the map's own order so a section reads stably. */
function orderedAreas(seen) {
  return Object.keys(AREA_MAP.areas).filter(area => seen.has(area));
}

/**
 * True for the two markers a build with nothing to show writes instead of
 * notes. They are file text, not shipped subjects, and neither is news.
 */
export function isNoChangeMarker(text) {
  return text === INITIAL_MARKER.slice(2) || text === NO_CHANGES_MARKER.slice(2);
}

/**
 * One shipped subject as the notes carry it: its linked sentence and the block
 * it belongs to, or null when a reader cannot see the change in it.
 */
export function readerFacingSubject(subject) {
  if (isNoChangeMarker(subject)) {
    return null;
  }
  const conventional = CONVENTIONAL_SUBJECT.exec(subject);
  const type = conventional ? conventional[1] : null;
  if (type !== null && INTERNAL_SUBJECT_TYPES.includes(type)) {
    return null;
  }
  const scope = conventional ? conventional[2] : undefined;
  if (scope !== undefined && DROP_SCOPES.has(scope.trim().toLowerCase())) {
    return null;
  }
  const body = conventional ? conventional[3] : subject;
  if (
    UNSEEN_WORK.some(pattern => pattern.test(body)) ||
    DROP_SUBJECT_PATTERNS.some(pattern => pattern.test(body))
  ) {
    return null;
  }
  const plain = body
    .replace(/\(\s*\[?#\d+.*$/, '')
    .trim()
    .toLowerCase();
  if (UNREADABLE_SUBJECTS.includes(plain)) {
    return null;
  }
  // A removal or a restriction is a change the reader should see, but it is not
  // a new feature: it joins the fixes the areas line counts.
  const isFeature = (type === null || type === 'feat') && !CHANGE_PREFIX.test(body);
  return {
    kind: isFeature ? 'new' : 'fix',
    text: linkPullRequest(subject),
    scope,
  };
}

/**
 * The body lines a section carries: its newest six features under `### New`,
 * then one `areas:` line naming the product areas its fixes touched. A section
 * whose work is all internal carries neither block, and the caller writes the
 * no-change marker instead.
 */
export function changelogBodyLines(subjects) {
  const news = [];
  const areas = new Set();
  let hasFixes = false;
  for (const subject of subjects) {
    const note = readerFacingSubject(subject);
    if (note === null) {
      continue;
    }
    if (note.kind === 'new') {
      news.push(note.text);
      continue;
    }
    hasFixes = true;
    areas.add(areaOfScope(note.scope));
  }
  const newest = news.slice(-NEW_SUBJECT_LIMIT).reverse();
  const lines = [];
  if (newest.length > 0) {
    lines.push('### New', '', ...newest.map(note => `- ${note}`));
  }
  if (hasFixes) {
    if (lines.length > 0) {
      lines.push('');
    }
    const named = orderedAreas(areas);
    lines.push(
      '### Fixes',
      '',
      `- areas: ${named.length === 0 ? AREA_MAP.generic : named.join(', ')}`
    );
  }
  return lines;
}

/** `subject` without the pull request reference a changelog line ends in. */
export function plainSubject(subject) {
  return subject
    .replace(/\s*\(\[#\d+\]\([^)]*\)\)$/, '')
    .replace(/\s*\(#\d+\)$/, '')
    .trim();
}

/**
 * One shipped subject as the rewrite sees it: the block the shared table puts
 * it in, the area its scope names, and its plain sentence. This is the same
 * filter the deterministic block applies, so the model never rewrites work the
 * table already dropped.
 */
export function rewriteCandidates(subjects) {
  const candidates = [];
  for (const subject of subjects) {
    const note = readerFacingSubject(subject);
    if (note === null) {
      continue;
    }
    candidates.push({
      kind: note.kind,
      area: note.scope === undefined ? AREA_MAP.generic : areaOfScope(note.scope),
      text: plainSubject(subject),
    });
  }
  return candidates;
}

const NOTES_PROMPT = [
  'You write the release notes for the Kilo mobile app. The reader is a Kilo app user, not a developer.',
  '',
  'Reply with one JSON object and nothing else:',
  '{"new":["..."],"changes":["..."],"areas":["..."]}',
  '',
  'new: at most 6 lines. Each line names one outcome the reader can now see or do,',
  'in plain language, starting with a capital letter. Order newest first. Never',
  'mention code, files, endpoints, pull requests, tests, refactors or backend',
  'internals. Use [] when the build shipped nothing a reader can see.',
  '',
  'Name things the way the app shows them to the reader, not by their internal',
  'name: say "an alert about a session that failed to start", not "dispatch',
  'failure alert". Avoid developer terms such as "tool interface",',
  '"command-line agent", "confirmed account" or "mode"; say what the reader does',
  'or sees instead. Spell out abbreviations such as "PR". Lead with the subject',
  'the reader knows, for example "Cloud Agent can now ...".',
  '',
  'changes: at most 6 lines for policy or behaviour changes the reader must know',
  'about: a removed sale, expiring credits, a discontinued benefit or a new',
  'restriction. Word each one neutrally, without praise or apology. Leave out',
  'anything that cannot apply to a reader who already uses the app, such as how',
  'new sign-ups are screened, and never describe abuse, fraud or risk screening.',
  'Use [] when there are none.',
  '',
  `areas: at most 3 product areas the fixes touched, as exact keys from this list:`,
  `${CURATED_AREAS.join(', ')}. Use [] when the build shipped no fixes, and leave`,
  'out a fix whose area above reads "app": it belongs to no named area. When no',
  'fix names one, the notes read "Bug fixes and polish.", so [] is correct then.',
  '',
  'No line may contain a URL, a pull request reference such as (#123), backticks,',
  'an identifier (snake_case, camelCase or a file name), a commit type prefix such',
  'as "fix(mobile):", or markdown.',
].join('\n');

/** The user message: every candidate, oldest first, as `kind | area | subject`. */
export function notesPrompt(candidates) {
  return [
    'The next app build ships these changes, oldest first (kind | area | subject):',
    '',
    ...candidates.map(candidate => `${candidate.kind} | ${candidate.area} | ${candidate.text}`),
  ].join('\n');
}

/**
 * The answer shape, read by hand. This file imports nothing outside Node's
 * built-ins: the release workflow test runs a copy of it from a scratch
 * directory with no node_modules, and the release job must be able to run it
 * from anywhere in the checkout.
 */
function readAnswer(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: 'it was not a JSON object' };
  }
  const fields = Object.keys(payload).sort();
  if (fields.join(',') !== 'areas,changes,new') {
    return { error: 'it did not carry exactly new, changes and areas' };
  }
  for (const field of ['new', 'changes', 'areas']) {
    const value = payload[field];
    if (!Array.isArray(value) || !value.every(line => typeof line === 'string')) {
      return { error: `its ${field} was not a list of lines` };
    }
  }
  for (const area of payload.areas) {
    if (!CURATED_AREAS.includes(area)) {
      return { error: `it named an unknown area: ${area}` };
    }
  }
  return { answer: { new: payload.new, changes: payload.changes, areas: payload.areas } };
}

/**
 * The first choice of a chat completion: its message content, and the details a
 * failure diagnostic names. `null` when the body carries no first choice with a
 * message at all.
 *
 * A reasoning model reports its thinking beside the answer, under `reasoning`,
 * `reasoning_content` or `reasoning_details`; those are never the answer and are
 * read only to say whether they were there.
 */
function readCompletion(payload) {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const choice = choices[0];
  if (choice === null || typeof choice !== 'object') {
    return null;
  }
  const message = choice.message;
  if (message === null || typeof message !== 'object') {
    return null;
  }
  return {
    content: typeof message.content === 'string' ? message.content : null,
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    reasoning:
      typeof message.reasoning === 'string' ||
      typeof message.reasoning_content === 'string' ||
      (Array.isArray(message.reasoning_details) && message.reasoning_details.length > 0),
  };
}

/**
 * The model's answer as the reader gets it, for a failure log: the finish reason,
 * how much content arrived, whether a reasoning field was beside it, and the first
 * 120 characters of that content, JSON-quoted so line breaks cannot split the log
 * line. Model output only.
 */
function answerDiagnostic(completion) {
  const content = completion.content ?? '';
  return [
    `finish_reason ${completion.finishReason ?? 'absent'}`,
    `${content.length} content characters`,
    completion.reasoning ? 'a reasoning field present' : 'no reasoning field',
    `content starts ${JSON.stringify(content.slice(0, 120))}`,
  ].join(', ');
}

// A line that names code rather than an outcome: a code span, snake_case,
// camelCase (a two-letter lowercase run keeps iPhone and iPad out of it, and the
// lowercase after the hump keeps macOS and watchOS out), a source file name, a
// call, or a conventional-commit prefix.
const CODE_IN_LINE = [
  /`/,
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/,
  /\b[a-z]{2,}[A-Z][a-z]+[A-Za-z0-9]*\b/,
  /\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|sql|ya?ml|toml)\b/i,
  /\b\w+\(\)/,
  /^(?:feat|fix|perf|chore|docs|test|build|ci|refactor|style|revert)(?:\([^)]*\))?!?:/i,
];
const URL_IN_LINE = /https?:\/\/|www\./i;
// The reference shapes a commit subject carries: a linked `([#123](url))`, a
// bare reference `(#123)`, `[#123]`, a `pull/123` path, and a `#123` that ends
// the line or closes a parenthesis. A sentence that counts something ("ranked
// #1 for speed") is not a pull request, so it is left alone.
const PULL_REQUEST_IN_LINE = /\(#\d+\)|\[#\d+\]|\bpull\/\d+\b|(?:^|\s)#\d+(?=$|\))/;

/** The reason `line` cannot be printed as a note, or null when it can. */
export function noteLineProblem(line) {
  if (line.length === 0) {
    return 'an empty line';
  }
  if (line.length > CURATED_LINE_LIMIT) {
    return `a line longer than ${CURATED_LINE_LIMIT} characters`;
  }
  if (URL_IN_LINE.test(line)) {
    return 'a URL';
  }
  if (PULL_REQUEST_IN_LINE.test(line)) {
    return 'a pull request reference';
  }
  if (CODE_IN_LINE.some(pattern => pattern.test(line))) {
    return 'a code identifier';
  }
  return null;
}

/** One note line as the reader gets it: no list marker, one sentence, capitalised. */
function cleanNoteLine(line) {
  const text = line
    .replace(/^\s*[-*•]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.charAt(0).toLocaleUpperCase('en') + text.slice(1);
}

/**
 * Check one answer against the caps, the line rules and the fixes this build
 * actually shipped. `{ notes }` when every line may be printed, `{ error }` when
 * the answer has to be discarded for the deterministic block.
 */
export function validateCuratedNotes(payload, candidates) {
  const read = readAnswer(payload);
  if (read.error) {
    return { error: `the answer did not have the expected shape: ${read.error}` };
  }
  const { new: news, changes, areas } = read.answer;
  if (news.length > CURATED_NEW_LIMIT) {
    return { error: `the answer named ${news.length} new lines, more than ${CURATED_NEW_LIMIT}` };
  }
  if (changes.length > CURATED_CHANGES_LIMIT) {
    return {
      error: `the answer named ${changes.length} changes, more than ${CURATED_CHANGES_LIMIT}`,
    };
  }
  if (areas.length > CURATED_AREA_LIMIT) {
    return { error: `the answer named ${areas.length} areas, more than ${CURATED_AREA_LIMIT}` };
  }
  const lines = [...news, ...changes].map(cleanNoteLine);
  for (const line of lines) {
    const problem = noteLineProblem(line);
    if (problem !== null) {
      return { error: `the answer contained ${problem}: ${line}` };
    }
  }
  const hasFixes = candidates.some(candidate => candidate.kind === 'fix');
  if (lines.length === 0 && areas.length === 0 && !hasFixes) {
    return { error: 'the answer named no new line, no change and no area' };
  }
  // A build without fixes names no area: the fixes line is what the answer
  // replaces, so an area there would tell the reader the release did something
  // it did not. A build with fixes may name none — an unmapped fix belongs to
  // no product area — and its line then reads as bug fixes and polish.
  if (!hasFixes && areas.length > 0) {
    return { error: 'the answer named an area for a build that shipped no fixes' };
  }
  return {
    notes: {
      new: news.map(cleanNoteLine),
      changes: changes.map(cleanNoteLine),
      areas: orderedAreas(new Set(areas)),
      hasFixes,
    },
  };
}

/**
 * The block a curated version writes: New, then Changes, then the fixes line.
 * A build whose fixes name no product area writes the generic `app` tag, which
 * the screen reads as "Bug fixes and polish.".
 */
export function curatedBodyLines(notes) {
  const lines = [];
  if (notes.new.length > 0) {
    lines.push('### New', '', ...notes.new.map(note => `- ${note}`));
  }
  if (notes.changes.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('### Changes', '', ...notes.changes.map(change => `- ${change}`));
  }
  if (notes.hasFixes) {
    if (lines.length > 0) {
      lines.push('');
    }
    const named = notes.areas.length === 0 ? AREA_MAP.generic : notes.areas.join(', ');
    lines.push('### Fixes', '', `- areas: ${named}`);
  }
  return lines;
}

/**
 * Every JSON object in a model answer, in the order it wrote them. Scans for
 * balanced `{...}` rather than accepting only a bare body or a fenced block: a
 * reasoning model may put a sentence, a heading or a fence in front of the
 * object it was asked for, and trailing prose must not hide it either. It may
 * also echo the prompt's placeholder shape before its real answer, so the
 * caller checks each object until one passes. Only top-level objects count: a
 * scan resumes after an object that parsed, so an object nested inside an
 * answer is never collected as a later answer.
 */
function parseAnswers(content) {
  const answers = [];
  let start = content.indexOf('{');
  while (start !== -1) {
    let next = start + 1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < content.length; index += 1) {
      const character = content[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === '{') {
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            answers.push(JSON.parse(content.slice(start, index + 1)));
            next = index + 1;
          } catch {
            // Not JSON here; a later `{` may open the object instead.
          }
          break;
        }
      }
    }
    start = content.indexOf('{', next);
  }
  return answers;
}

/**
 * Ask the gateway to rewrite one version's candidates. `{ lines }` when the
 * answer passed every check, `{ error }` otherwise: the caller writes the
 * deterministic block and warns, so a model failure never fails a release.
 *
 * `KILO_CHANGELOG_API_KEY` carries the credential, `KILO_CHANGELOG_BASE_URL`
 * points at another gateway (a local fake in tests), and
 * `KILO_CHANGELOG_TIMEOUT_MS` shortens the wait. The key is read here and sent
 * only as the bearer token; nothing logs it.
 */
export async function requestCuratedNotes(candidates, options = {}) {
  const apiKey = options.apiKey ?? process.env.KILO_CHANGELOG_API_KEY;
  if (!apiKey) {
    return { error: 'KILO_CHANGELOG_API_KEY is not set' };
  }
  const baseUrl = (
    options.baseUrl ??
    process.env.KILO_CHANGELOG_BASE_URL ??
    NOTES_BASE_URL_DEFAULT
  ).replace(/\/+$/, '');
  const configuredTimeout = Number(options.timeoutMs ?? process.env.KILO_CHANGELOG_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : NOTES_TIMEOUT_DEFAULT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  let response;
  try {
    response = await fetchImpl(`${baseUrl}${NOTES_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: NOTES_MODEL,
        // No temperature: the briefing's working call sends none, and a
        // reasoning model's own sampling is not what fixes this answer's shape.
        max_tokens: NOTES_MAX_TOKENS,
        stream: false,
        messages: [
          { role: 'system', content: NOTES_PROMPT },
          { role: 'user', content: notesPrompt(candidates) },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return { error: `the notes model did not answer within ${timeoutMs}ms` };
    }
    return { error: `the notes model could not be reached (${reasonOf(error)})` };
  }
  if (!response.ok) {
    return { error: `the notes model answered HTTP ${response.status}` };
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return { error: 'the notes model returned a body that is not JSON' };
  }
  const completion = readCompletion(payload);
  if (completion === null || completion.content === null) {
    return { error: 'the notes model returned no message content' };
  }
  const answers = parseAnswers(completion.content);
  if (answers.length === 0) {
    return {
      error: `the notes model returned invalid JSON (${answerDiagnostic(completion)})`,
    };
  }
  // The model may quote the prompt's placeholder object before it writes the
  // real answer, so the first object that parses is not the answer to read: the
  // first that passes is. When none passes, the last object's error is the one
  // that describes the final answer the model wrote.
  let invalid = null;
  for (const answer of answers) {
    const validated = validateCuratedNotes(answer, candidates);
    if (!validated.error) {
      return { lines: curatedBodyLines(validated.notes) };
    }
    invalid = validated;
  }
  return invalid;
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
export function headingOf(section) {
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
    ...APP_LOCAL_EXCLUDES,
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

async function runBody(args) {
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
  const deterministic = changelogBodyLines(subjects);
  if (deterministic.length === 0) {
    console.log(NO_CHANGES_MARKER);
    return 0;
  }
  // The rewrite is an improvement, never a gate: a missing key, a slow call or
  // an answer that fails validation leaves the release on the deterministic
  // block, with the reason on stderr for the run's log.
  const curated = await requestCuratedNotes(rewriteCandidates(subjects));
  const lines = curated.lines ?? deterministic;
  if (curated.error) {
    console.error(`changelog: ${curated.error}; writing the release notes without the model`);
  }
  for (const line of lines) {
    console.log(line);
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
export function commitOn(parent, path, content, message) {
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

// Only the shallow checkout the changelog job makes (`fetch-depth: 1`) uses this
// ladder: it has to deepen before a common base with main is reachable. The
// measured version-bump branch sat 434 commits behind its merge base with main,
// and a --depth=200 fetch of both refs still produced no merge base, so the
// ladder starts above that case. A complete clone already holds the objects, so
// it gets one plain fetch (`0`) instead and its history is never truncated.
const VERIFY_DEPTHS = [512, 2048, 8192, 0];

/**
 * Fetch one ref for the provenance check, and the tip it now names.
 *
 * The ref is fetched by plain name (`main`, the branch) rather than by the sha
 * the run already knows, because GitHub does not serve an unadvertised sha. A
 * missing ref is `{ error }` rather than a throw: the caller retries the land,
 * so a git failure never hides behind an exception and never becomes a verdict
 * on the branch's shape.
 */
function fetchForVerify(remote, ref, depth) {
  const args = ['fetch', '--no-tags', '--quiet'];
  try {
    if (depth > 0) {
      args.push(`--depth=${depth}`);
    } else if (git(['rev-parse', '--is-shallow-repository']).trim() === 'true') {
      args.push('--unshallow');
    }
    args.push(remote, ref);
    git(args, { stdio: ['ignore', 'pipe', 'pipe'] });
    return { sha: git(['rev-parse', 'FETCH_HEAD']).trim() };
  } catch (error) {
    if (isMissingRef(error)) {
      return { error: `${ref} does not exist on ${remote}` };
    }
    return { error: reasonOf(error) };
  }
}

/** Every path `tip` changes relative to `base`. */
function replacedFiles(base, tip) {
  return git(['diff', '--name-only', base, tip])
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

/** The app.config.ts diff between `base` and `tip`, for the version-line rule. */
function replacedConfigDiff(base, tip) {
  return git(['diff', '-U0', base, tip, '--', 'apps/mobile/app.config.ts']);
}

/**
 * The provenance of the version-bump branch, as `{ ok: true, base }`,
 * `{ ok: false, retry: true, reason }` or `{ ok: false, reason }`.
 *
 * A merge base between main and the branch must exist: the branch must be the
 * version bump this run built. Main's own tip need not be an ancestor, because
 * main advances during the ~60-minute build window. The branch's diff from that
 * base must be the version line and the changelog only, the same shape
 * `isVersionBumpCommit` guards for the release detection.
 *
 * Only a branch that was actually read can be refused. A fetch that failed - a
 * missing ref, a transient network error - says nothing about the branch's
 * shape, so it is `retry`: the caller tries the land again and, when the
 * attempts run out, carries the section to the pending branch. A determined
 * refusal is reserved for a branch every rung fetched whose history has no
 * merge base with main, whose diff touches a file outside the version-bump set,
 * or whose apps/mobile/app.config.ts diff changes more than the version line.
 *
 * `tip` is the branch commit the section is about to be written onto. A branch
 * that moved since the caller fetched it is reported as such, so the caller can
 * retry instead of writing the section onto a commit nobody checked.
 */
function verifyBumpBranch(remote, branch, tip) {
  let base;
  let fetchFailure;
  let mergeBaseChecked = false;
  // A complete repository already has every object, and deepening it would turn
  // a previous complete clone into a shallow one: one plain fetch is enough. The
  // ladder only helps a shallow checkout reach the fork point.
  const shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
  for (const depth of shallow ? VERIFY_DEPTHS : [0]) {
    const main = fetchForVerify(remote, 'main', depth);
    if (main.error) {
      fetchFailure = main.error;
      continue;
    }
    const head = fetchForVerify(remote, branch, depth);
    if (head.error) {
      fetchFailure = head.error;
      continue;
    }
    if (head.sha !== tip) {
      return {
        ok: false,
        moved: true,
        reason: 'the branch moved while the changelog was being composed',
      };
    }
    try {
      base = git(['merge-base', main.sha, head.sha]).trim();
      mergeBaseChecked = true;
      break;
    } catch {
      // A shallow history that does not reach the fork point has no base yet:
      // the next rung fetches deeper.
      mergeBaseChecked = true;
    }
  }
  if (!base) {
    // A branch that was not read cannot be judged, so it is retried: the caller
    // carries the section when the retries run out. Only history every rung
    // fetched, with no common commit with main, is a determined refusal.
    if (fetchFailure) {
      return {
        ok: false,
        retry: true,
        reason: `it could not be read: ${fetchFailure}`,
      };
    }
    if (!mergeBaseChecked) {
      return {
        ok: false,
        retry: true,
        reason: 'it could not be read: no rung fetched both refs',
      };
    }
    return { ok: false, reason: 'it shares no history with main' };
  }

  let files;
  let configDiff;
  try {
    files = replacedFiles(base, tip);
    configDiff = replacedConfigDiff(base, tip);
  } catch (error) {
    // A local git failure after a successful fetch is not a verdict on the
    // branch's shape either.
    return { ok: false, retry: true, reason: reasonOf(error) };
  }
  if (!isVersionBumpCommit(files, configDiff)) {
    const offending = files.filter(file => !VERSION_BUMP_FILES.has(file));
    if (offending.length > 0) {
      return {
        ok: false,
        reason: `it changes files other than the version line and the changelog: ${offending.join(', ')}`,
      };
    }
    return {
      ok: false,
      reason: files.includes('apps/mobile/app.config.ts')
        ? 'its apps/mobile/app.config.ts diff changes more than the version line'
        : 'it carries no apps/mobile/app.config.ts version line',
    };
  }
  return { ok: true, base };
}

/**
 * Carry the composed section to the pending branch, and return 0 or a failure
 * status. `opener` is the leading phrase of a failure message, so the refusal
 * and the exhausted-retry paths each say why they are carrying.
 */
function carryToPending(options, heading, section, pendingRead, opener) {
  const separator = options.land.lastIndexOf(':');
  const remote = options.land.slice(0, separator);
  if (pendingRead.error) {
    return fail(
      `${opener}, and ${options.pending} could not be read (${pendingRead.error}); refusing to overwrite the sections it carries`
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
  return fail(`${opener} or carry it to ${options.pending} (${carryFailure})`);
}

/**
 * The two machine-readable lines the release workflow parses after a land: the
 * verified head the section now sits on and the files it changed.
 */
function printVerifiedLand(sha, files) {
  console.log(`changelog-head=${sha}`);
  console.log(`changelog-files=${files.join(', ')}`);
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
    // The land-time check requires the branch to carry only the version line
    // and the changelog from its merge base with main. A branch that moved, or
    // that could not be read, is retried; a branch that was read and does not
    // have that shape receives the section neither now nor on a later run,
    // until it is replaced.
    const check = verifyBumpBranch(remote, branch, parent);
    if (!check.ok) {
      if (check.moved || check.retry) {
        console.log(`changelog: attempt ${attempt} rejected (${check.reason})`);
        continue;
      }
      const refusal = `refusing to land ${heading} on ${branch}: ${check.reason}`;
      const carried = carryToPending(options, heading, section, pendingRead, refusal);
      if (carried !== 0) {
        return carried;
      }
      return fail(`${refusal}; the section was carried to ${options.pending}`);
    }
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
      printVerifiedLand(parent, replacedFiles(check.base, parent));
      return 0;
    }
    const sha = commitOn(parent, options.changelog, insertSection(content, block), message);
    try {
      git(['push', remote, `${sha}:refs/heads/${branch}`]);
      console.log(`changelog: landed ${heading} on ${branch} as ${sha}`);
      if (pending.length > 0) {
        clearPending(remote, options.pending, pendingRead.sha);
      }
      printVerifiedLand(sha, replacedFiles(check.base, sha));
      return 0;
    } catch (error) {
      console.log(`changelog: attempt ${attempt} rejected (${reasonOf(error)})`);
    }
  }

  // The branch was merged and deleted while the build ran. The submission
  // already succeeded, so the run stays green: the section waits for the next
  // build's section instead of being lost.
  return carryToPending(
    options,
    heading,
    section,
    pendingRead,
    `could not land ${heading} on ${branch}`
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
  process.exit(await main());
}
