/**
 * The bundled changelog as a reader wants it: one item per version, a short
 * "New" list of what shipped, the policy changes a reader must know about, and
 * one line naming the areas the fixes touched.
 *
 * `CHANGELOG.md` is written by the Release workflow for maintainers, not for
 * the screen. Its title and preamble say how the file is maintained, one
 * section is composed per store build — so one version arrives as several — and
 * every bullet is a commit subject (`fix(mobile): ...`) or, in sections written
 * after this screen existed, a curated line under a `### New`, `### Changes` or
 * `### Fixes` heading.
 *
 * The file is generated output whose shipped sections are already part of the
 * record, so the reader-facing shape is derived here instead of by rewriting
 * it. Both shapes land on the same blocks: the newest features as sentences,
 * the policy changes as neutral statements, and the fixes as the product areas
 * they touch — the scope table that names those areas lives in
 * `changelog-areas.json`, which the Release workflow applies when it composes a
 * section (`scripts/kilo-app-release-notes.mjs`). A version without headings
 * keeps the derived shape.
 */

import areas from './changelog-areas.json';

/** A product area a fix touched: a key of `changelog-areas.json`'s `areas`. */
export type ChangelogArea = keyof typeof areas.areas;

/**
 * One version's notes. They are what the reader is shown, not the file:
 * `newNotes` is capped at the newest few features, `changeNotes` at the few
 * policy changes, and `fixesAreas` is empty when the fixes touched no named
 * area (`hasFixes` still marks them).
 */
export type ChangelogSection = Readonly<{
  /** `1.0.16`, or the heading's own words when it names no version. */
  version: string;
  /** The newest features, newest first: a sentence each, no prefix, no link. */
  newNotes: readonly string[];
  /** The policy changes a reader must know about, in the order they were written. */
  changeNotes: readonly string[];
  /** The areas the fixes touched, in the map's own order. */
  fixesAreas: readonly ChangelogArea[];
  /** Whether the version shipped fix work at all. */
  hasFixes: boolean;
}>;

/** How many features one version lists; the rest ship their note in the areas line. */
const NEW_NOTE_LIMIT = 6;

/** How many policy changes one version lists; the workflow caps them the same way. */
const CHANGE_NOTE_LIMIT = 6;

const RELEASE_HEADING = /^## (.+)$/;
const GROUP_HEADING = /^### (.+)$/;
const NOTE = /^- (.+)$/;

/** `1.0.16` in `1.0.16 (build 720 iOS, 721 Android)`. */
const VERSION_PREFIX = /^\d+\.\d+\.\d+/;

/** `fix(mobile)!: ` in a commit subject: the type, its scope and the separator. */
const CONVENTIONAL_PREFIX = /^([a-z][a-z-]*)(?:\(([^)]*)\))?!?:\s+(.+)$/;

/** A slash-joined type, as `chore/remove autotriage code` writes one. */
const SLASHED_TYPE = /^[a-z][a-z-]*\//;

/** The pull request a section's bullet shipped in: `([#10334](url))`. */
const PULL_REQUEST_LINK = /\s*\(\[#\d+\]\([^)]*\)\)$/;

/** The older sections' bare reference: `(#6670)`. */
const BARE_PULL_REQUEST = /\s*\(#\d+\)$/;

/** The generated sections' machine line: `areas: chat, sign-in`. */
const AREAS_LINE = /^areas:\s*(.*)$/;

/**
 * The commit types whose work a reader cannot see in the app. The rest — `feat`,
 * `fix`, `perf`, and any subject with no conventional prefix — ship a change.
 */
const INTERNAL_TYPES = {
  build: true,
  chore: true,
  ci: true,
  docs: true,
  refactor: true,
  style: true,
  test: true,
} satisfies Readonly<Record<string, true>>;

/** The feature types: what belongs in the New list. */
const FEATURE_TYPES = { feat: true } satisfies Readonly<Record<string, true>>;

/** The three blocks a composed section states its notes under. */
const GROUPS = ['new', 'changes', 'fixes'] as const;

/** The workflow's bodies for a section that carries no reader-facing change. */
const NO_CHANGE_NOTES = {
  'Initial release: no earlier build to compare against.': true,
  'No user-visible changes since the previous build.': true,
} satisfies Readonly<Record<string, true>>;

/**
 * Subjects a reader cannot see a change in even though their commit type ships
 * one: a demo behind a flag, the app's own transport plumbing, and the tweaks
 * that only move a card's padding or drop a section label. Matched against the
 * subject after its conventional prefix comes off.
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
 * Shipped subjects that name no change in a sentence. The file is generated
 * output, so an ungrammatical subject cannot be rewritten at its source after
 * it landed; the screen leaves it out instead of printing it as news.
 */
const UNREADABLE_NOTES = {
  'answer the request a glanceable approval names': true,
} satisfies Readonly<Record<string, true>>;

/**
 * The policy the NEW group and the Release composer share: the scopes that
 * never reach the phone app, the subjects that name no phone change, and the
 * leading verbs that state a removal or a restriction instead of a feature.
 */
const DROP_SCOPES = new Set(areas.newGroup.dropScopes.map(scope => scope.toLocaleLowerCase('en')));
const DROP_SUBJECT_PATTERNS = areas.newGroup.dropSubjectPatterns.map(
  pattern => new RegExp(pattern, 'i')
);
const CHANGE_PREFIX = new RegExp(`^(?:${areas.newGroup.changePrefixes.join('|')})\\b`, 'i');

/** How many areas the fixes line names; the rest are the polish behind them. */
const FIXES_AREA_LIMIT = 3;

/** `1.0.16` from its heading; the heading's own words when it names no version. */
function versionOf(heading: string): string {
  const text = heading.trim();
  return VERSION_PREFIX.exec(text)?.[0] ?? text;
}

/**
 * `subject` without the pull request reference a commit subject ends in.
 *
 * The changelog links the pull request a change shipped in, which is how a
 * maintainer traces it. A reader has no use for the number, and the link is not
 * drawn here, so both forms of the reference come off with the rest of the
 * record.
 */
function withoutPullRequest(subject: string): string {
  const link = PULL_REQUEST_LINK.exec(subject);
  const withoutLink = link ? subject.slice(0, link.index) : subject;
  const bare = BARE_PULL_REQUEST.exec(withoutLink);
  return (bare ? withoutLink.slice(0, bare.index) : withoutLink).trim();
}

/** The area a commit scope names, or null when the map has no entry for it. */
function areaOfScope(scope: string | undefined): ChangelogArea | null {
  if (scope === undefined) {
    return null;
  }
  const key = scope.trim().toLocaleLowerCase('en');
  const area: unknown = (areas.scopeToArea as Record<string, string | undefined>)[key];
  return area === undefined ? null : (area as ChangelogArea);
}

/** A bullet as the reader gets it, or null when the bullet is internal work. */
type ReaderNote = Readonly<{ kind: 'new' | 'fix'; text: string; scope?: string }>;

function readerFacingNote(bullet: string): ReaderNote | null {
  const line = bullet.trim();
  if (Object.hasOwn(NO_CHANGE_NOTES, line) || line.startsWith('(') || SLASHED_TYPE.test(line)) {
    return null;
  }
  const conventional = CONVENTIONAL_PREFIX.exec(line);
  const type = conventional?.[1];
  if (type !== undefined && Object.hasOwn(INTERNAL_TYPES, type)) {
    return null;
  }
  const scope = conventional?.[2];
  if (scope !== undefined && DROP_SCOPES.has(scope.trim().toLocaleLowerCase('en'))) {
    return null;
  }
  const subject = withoutPullRequest(conventional?.[3] ?? line);
  if (
    subject === '' ||
    UNSEEN_WORK.some(pattern => pattern.test(subject)) ||
    DROP_SUBJECT_PATTERNS.some(pattern => pattern.test(subject))
  ) {
    return null;
  }
  if (Object.hasOwn(UNREADABLE_NOTES, subject.toLocaleLowerCase('en'))) {
    return null;
  }
  // A removal or a restriction is a change the reader should see, but it is
  // not a new feature: it joins the fixes the areas line counts.
  const isFix =
    (type !== undefined && !Object.hasOwn(FEATURE_TYPES, type)) || CHANGE_PREFIX.test(subject);
  // The notes are English commit subjects, so the English casing is the right
  // one: a Turkish device would otherwise take the leading `i` to `İ`.
  const text = subject.charAt(0).toLocaleUpperCase('en') + subject.slice(1);
  return isFix ? { kind: 'fix', text, scope } : { kind: 'new', text };
}

/** The areas a list of scopes names, in the map's own order. */
function orderedAreas(seen: Iterable<ChangelogArea>): ChangelogArea[] {
  const present = new Set<ChangelogArea>(seen);
  return (Object.keys(areas.areas) as ChangelogArea[]).filter(area => present.has(area));
}

/** The areas a generated `areas:` line names, ignoring tags this build does not ship. */
function areasOfLine(line: string): ChangelogArea[] {
  const match = AREAS_LINE.exec(line.trim());
  if (match === null) {
    return [];
  }
  const known = new Set<string>(Object.keys(areas.areas));
  const tags = (match[1] ?? '')
    .split(',')
    .map(tag => tag.trim())
    .filter(tag => known.has(tag));
  return orderedAreas(tags as ChangelogArea[]);
}

/**
 * One version under construction while the file is read: the group it is in,
 * the features it has collected, the policy changes it carries, and the areas
 * its fixes named. A generated section states its blocks itself; a
 * commit-subject section is classified from each bullet's type and scope.
 * `group`, `curated` and `buildNotes` describe the build whose heading was read
 * last: a later heading of the same version starts a new build, and its older
 * bullets must not inherit the groups above them.
 */
type Draft = {
  version: string;
  group: 'new' | 'changes' | 'fixes' | null;
  /** A section the workflow composed: its blocks are already curated and ordered. */
  curated: boolean;
  newNotes: string[];
  /** The features this build has contributed; its notes sit at the front of the list. */
  buildNotes: number;
  changeNotes: string[];
  /** How many fixes named each area; the line names the busiest few. */
  fixesCounts: Map<ChangelogArea, number>;
  isFix: boolean;
};

function emptyDraft(version: string): Draft {
  return {
    version,
    group: null,
    curated: false,
    newNotes: [],
    buildNotes: 0,
    changeNotes: [],
    fixesCounts: new Map(),
    isFix: false,
  };
}

/** One more fix for `area`. */
function countArea(counts: Map<ChangelogArea, number>, area: ChangelogArea): void {
  counts.set(area, (counts.get(area) ?? 0) + 1);
}

/**
 * Adds one bullet to the draft. A generated `areas:` line lands as the fixes
 * block, a `### Changes` bullet lands as a neutral statement, and any other
 * bullet lands in the group its heading names or — in a section with no
 * headings — in the block its commit type names.
 */
function absorb(draft: Draft, bullet: string): void {
  if (draft.group === 'changes') {
    const change = withoutPullRequest(bullet).trim();
    if (change !== '') {
      // A `### Changes` section is curated already, so the line is the copy
      // the reader gets; only its first letter is normalised.
      draft.changeNotes.push(change.charAt(0).toLocaleUpperCase('en') + change.slice(1));
    }
    return;
  }
  if (draft.group === 'fixes') {
    for (const area of areasOfLine(bullet)) {
      countArea(draft.fixesCounts, area);
    }
    draft.isFix = true;
    return;
  }
  const note = readerFacingNote(bullet);
  if (note === null) {
    return;
  }
  // The `### Fixes` block returned above, so this bullet is either a composed
  // New bullet (no prefix, so it reads `new`) or a shipped one whose type decides.
  if (note.kind === 'new') {
    // A shipped build is a commit log read oldest-first, so each feature goes in
    // front of the ones this build already listed; a composed section already
    // lists newest first and keeps its order. Either way the list stays
    // newest-first across the whole version: a later, older build's notes land
    // after the newer build's, never in front of them, so the cap below cannot
    // drop the newest features.
    if (draft.curated) {
      draft.newNotes.push(note.text);
    } else {
      draft.newNotes.splice(draft.newNotes.length - draft.buildNotes, 0, note.text);
    }
    draft.buildNotes += 1;
    return;
  }
  draft.isFix = true;
  const area = areaOfScope(note.scope);
  if (area !== null) {
    countArea(draft.fixesCounts, area);
  }
}

/**
 * The areas with the most fixes first, at most `FIXES_AREA_LIMIT`; a tie keeps
 * the map's own order so a section reads stably.
 */
function topAreas(counts: ReadonlyMap<ChangelogArea, number>): ChangelogArea[] {
  return (Object.keys(areas.areas) as ChangelogArea[])
    .filter(area => (counts.get(area) ?? 0) > 0)
    .sort((left, right) => (counts.get(right) ?? 0) - (counts.get(left) ?? 0))
    .slice(0, FIXES_AREA_LIMIT);
}

/** The draft as the screen gets it: the newest few features, the changes, then the areas. */
function toSection(draft: Draft): ChangelogSection | null {
  // A composed section already lists its newest features first; a shipped one
  // is a commit log, whose newest entry is the last line of the version.
  const newNotes = draft.newNotes.slice(0, NEW_NOTE_LIMIT);
  const changeNotes = draft.changeNotes.slice(0, CHANGE_NOTE_LIMIT);
  if (newNotes.length === 0 && changeNotes.length === 0 && !draft.isFix) {
    return null;
  }
  return {
    version: draft.version,
    newNotes,
    changeNotes,
    fixesAreas: topAreas(draft.fixesCounts),
    hasFixes: draft.isFix,
  };
}

/**
 * The release sections in file order, newest build first, one per version:
 * consecutive builds of one version merge into one item. Everything above the
 * first `## ` heading — the document title and the maintainer note — is not a
 * section, and a version with nothing a reader can see is not one either.
 */
export function changelogSections(markdown: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let draft: Draft | null = null;

  const flush = (): void => {
    const section = draft === null ? null : toSection(draft);
    if (section !== null) {
      sections.push(section);
    }
    draft = null;
  };

  for (const line of markdown.split('\n')) {
    const heading = RELEASE_HEADING.exec(line);
    if (heading === null) {
      const bullet = draft === null ? null : NOTE.exec(line);
      if (bullet?.[1] !== undefined && draft !== null) {
        absorb(draft, bullet[1]);
      }
    } else {
      const next = versionOf(heading[1] ?? '');
      // Every store build of one version is the same release to the reader, so
      // its notes keep accumulating under the heading already on screen.
      if (draft === null || draft.version !== next) {
        flush();
      }
      draft ??= emptyDraft(next);
      // A new heading starts a new build even when the version repeats. Without
      // this reset the older build's commit bullets inherit the newest build's
      // last `### ` group — they would land in its Changes list, or be counted
      // as fixes — and its features would join the list ahead of the newer
      // build's instead of behind them.
      draft.group = null;
      draft.curated = false;
      draft.buildNotes = 0;
    }
    const group = draft === null ? null : GROUP_HEADING.exec(line);
    if (group !== null && draft !== null) {
      const label = (group[1] ?? '').trim().toLocaleLowerCase('en');
      draft.curated = true;
      draft.group = GROUPS.find(candidate => candidate === label) ?? null;
    }
  }
  flush();
  return withoutRepeatedAreas(sections);
}

/**
 * The areas line a version shows next to the one above it: when a release's
 * busiest areas are the previous release's own, the line names polish instead,
 * because repeating the same three names tells the reader nothing new.
 */
function withoutRepeatedAreas(sections: ChangelogSection[]): ChangelogSection[] {
  return sections.map((section, index) => {
    const previous = sections[index + 1];
    if (previous === undefined || section.fixesAreas.length === 0) {
      return section;
    }
    const repeated =
      section.fixesAreas.length === previous.fixesAreas.length &&
      section.fixesAreas.every((area, position) => area === previous.fixesAreas[position]);
    return repeated ? { ...section, fixesAreas: [] } : section;
  });
}

/** `1.0.16` in `## 1.0.16 (build 720 iOS, 721 Android)`; anything else is null. */
const HEADING_VERSION = /^## (\d+)\.(\d+)\.(\d+)/gm;
const FULL_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

type Version = readonly [number, number, number];

function parseVersion(text: string | null | undefined): Version | null {
  const match = text ? FULL_VERSION.exec(text.trim()) : null;
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: Version, right: Version): number {
  const [leftMajor, leftMinor, leftPatch] = left;
  const [rightMajor, rightMinor, rightPatch] = right;
  const pairs: readonly (readonly [number, number])[] = [
    [leftMajor, rightMajor],
    [leftMinor, rightMinor],
    [leftPatch, rightPatch],
  ];
  for (const [a, b] of pairs) {
    if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

/**
 * The newest release heading's version in `markdown`, or null when no heading
 * carries one. Taken as a maximum rather than from the first heading so a
 * hand-edited file out of order still reports its newest release.
 */
function newestReleaseVersion(markdown: string): Version | null {
  let newest: Version | null = null;
  for (const match of markdown.matchAll(HEADING_VERSION)) {
    const version = parseVersion(`${match[1]}.${match[2]}.${match[3]}`);
    if (version && (!newest || compareVersions(version, newest) > 0)) {
      newest = version;
    }
  }
  return newest;
}

/**
 * True when the bundled notes end before the installed build. The Release
 * workflow writes a build's section after its submission lands, so the bytes
 * this build compiled carry the previous release.
 *
 * False when the newest section is the installed version, when the bundle
 * already carries a later one, and when either version cannot be read: a
 * notice about notes the reader may be looking at would be worse than none.
 */
export function changelogNotesArePending(
  markdown: string,
  installedVersion: string | null | undefined
): boolean {
  const installed = parseVersion(installedVersion);
  const newest = newestReleaseVersion(markdown);
  if (!newest || !installed) {
    return false;
  }
  return compareVersions(newest, installed) < 0;
}
