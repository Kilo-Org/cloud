/**
 * The bundled changelog as a reader wants it: one item per version, a short
 * "New" list of what shipped, and one line naming the areas the fixes touched.
 *
 * `CHANGELOG.md` is written by the Release workflow for maintainers, not for
 * the screen. Its title and preamble say how the file is maintained, one
 * section is composed per store build — so one version arrives as several — and
 * every bullet is a commit subject (`fix(mobile): ...`) or, in sections written
 * after this screen existed, a curated line under a `### New` or `### Fixes`
 * heading.
 *
 * The file is generated output whose shipped sections are already part of the
 * record, so the reader-facing shape is derived here instead of by rewriting
 * it. Both shapes land on the same two blocks: the newest features as
 * sentences, and the fixes as the product areas they touch — the scope table
 * that names those areas lives in `changelog-areas.json`, which the Release
 * workflow applies when it composes a section
 * (`scripts/kilo-app-release-notes.mjs`).
 */

import areas from './changelog-areas.json';

/** A product area a fix touched: a key of `changelog-areas.json`'s `areas`. */
export type ChangelogArea = keyof typeof areas.areas;

/**
 * One version's notes. They are what the reader is shown, not the file:
 * `newNotes` is capped at the newest few features, and `fixesAreas` is empty
 * when the fixes touched no named area (`hasFixes` still marks them).
 */
export type ChangelogSection = Readonly<{
  /** `1.0.16`, or the heading's own words when it names no version. */
  version: string;
  /** The newest features, newest first: a sentence each, no prefix, no link. */
  newNotes: readonly string[];
  /** The areas the fixes touched, in the map's own order. */
  fixesAreas: readonly ChangelogArea[];
  /** Whether the version shipped fix work at all. */
  hasFixes: boolean;
}>;

/** How many features one version lists; the rest ship their note in the areas line. */
const NEW_NOTE_LIMIT = 6;

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

/** The two blocks a composed section states its notes under. */
function groupOf(label: string): 'new' | 'fixes' | null {
  if (label === 'new') {
    return 'new';
  }
  return label === 'fixes' ? 'fixes' : null;
}

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
  const subject = withoutPullRequest(conventional?.[3] ?? line);
  if (subject === '' || UNSEEN_WORK.some(pattern => pattern.test(subject))) {
    return null;
  }
  if (Object.hasOwn(UNREADABLE_NOTES, subject.toLocaleLowerCase('en'))) {
    return null;
  }
  const isFix = type !== undefined && !Object.hasOwn(FEATURE_TYPES, type);
  // The notes are English commit subjects, so the English casing is the right
  // one: a Turkish device would otherwise take the leading `i` to `İ`.
  const text = subject.charAt(0).toLocaleUpperCase('en') + subject.slice(1);
  return isFix ? { kind: 'fix', text, scope: conventional?.[2] } : { kind: 'new', text };
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
 * the features it has collected, and the areas its fixes named. A generated
 * section states both blocks itself; a commit-subject section is classified
 * from each bullet's type and scope.
 */
type Draft = {
  version: string;
  group: 'new' | 'fixes' | null;
  /** A section the workflow composed: its blocks are already curated and ordered. */
  curated: boolean;
  newNotes: string[];
  fixesSeen: ChangelogArea[];
  isFix: boolean;
};

function emptyDraft(version: string): Draft {
  return { version, group: null, curated: false, newNotes: [], fixesSeen: [], isFix: false };
}

/**
 * Adds one bullet to the draft. A generated `areas:` line lands as the fixes
 * block; any other bullet lands in the group its heading names, or — in a
 * section with no headings — in the block its commit type names.
 */
function absorb(draft: Draft, bullet: string): void {
  if (draft.group === 'fixes') {
    draft.fixesSeen = orderedAreas([...draft.fixesSeen, ...areasOfLine(bullet)]);
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
    // A shipped version is a commit log read oldest-first, so each feature goes
    // in front of the one before it; a composed section already lists newest
    // first and keeps its order.
    if (draft.curated) {
      draft.newNotes.push(note.text);
    } else {
      draft.newNotes.unshift(note.text);
    }
    return;
  }
  draft.isFix = true;
  const area = areaOfScope(note.scope);
  if (area !== null) {
    draft.fixesSeen = orderedAreas([...draft.fixesSeen, area]);
  }
}

/** The draft as the screen gets it: the newest few features, then the areas. */
function toSection(draft: Draft): ChangelogSection | null {
  // A composed section already lists its newest features first; a shipped one
  // is a commit log, whose newest entry is the last line of the version.
  const newNotes = draft.newNotes.slice(0, NEW_NOTE_LIMIT);
  if (newNotes.length === 0 && !draft.isFix) {
    return null;
  }
  return {
    version: draft.version,
    newNotes,
    fixesAreas: orderedAreas(draft.fixesSeen),
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
    }
    const group = draft === null ? null : GROUP_HEADING.exec(line);
    if (group !== null && draft !== null) {
      const label = (group[1] ?? '').trim().toLocaleLowerCase('en');
      draft.curated = true;
      draft.group = groupOf(label);
    }
  }
  flush();
  return sections;
}

/** `1.0.16` in `## 1.0.16 (build 720 iOS, 721 Android)`; anything else is null. */
const HEADING_VERSION = /^## (\d+)\.(\d+)\.(\d+)/gm;
const FULL_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

type Version = readonly [number, number, number];

function parseVersion(text: string | null | undefined): Version | null {
  if (!text) {
    return null;
  }
  const match = FULL_VERSION.exec(text.trim());
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
