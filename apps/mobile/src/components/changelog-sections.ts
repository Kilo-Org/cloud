/**
 * The bundled changelog as a reader wants it: one item per version, with the
 * maintainer's parts of the source file removed.
 *
 * `CHANGELOG.md` is written by the Release workflow for maintainers, not for
 * the screen. Its title and preamble say how the file is maintained, every
 * bullet is a commit subject (`fix(mobile): ...`) that ends in a link to its
 * pull request, and one section is composed per store build — so one version
 * arrives as several. A section can also list work no reader can see (tests,
 * docs, CI, refactors, a demo behind a flag, transport plumbing) and one bullet
 * per language for the catalogs.
 *
 * The file is generated output whose shipped sections are already part of the
 * record, so the reader-facing shape is derived here instead of by rewriting
 * it. The Release workflow drops the same classes of subject when it composes a
 * new section (`scripts/kilo-app-release-notes.mjs`).
 */

import { translationLanguagesIn } from './changelog-translation-languages';

/**
 * One version's notes. The file carries a section per store build, and every
 * build of a version lands here as one item: the reader sees one list, one
 * heading, and one gap between versions.
 */
export type ChangelogSection = Readonly<{
  /** `1.0.16`, or the heading's own words when it names no version. */
  version: string;
  /** One sentence per change: no bullet, no commit prefix, no pull request reference. */
  notes: readonly string[];
  /**
   * The languages whose copy this version corrected, as the picker's English
   * names, in the order the file names them. Drawn as one line, in the
   * reader's own words.
   */
  translationLanguages: readonly string[];
}>;

const RELEASE_HEADING = /^## (.+)$/;
const NOTE = /^- (.+)$/;

/** `1.0.16` in `1.0.16 (build 720 iOS, 721 Android)`. */
const VERSION_PREFIX = /^\d+\.\d+\.\d+/;

/** `fix(mobile)!: ` in a commit subject: the type, its scope and the separator. */
const CONVENTIONAL_PREFIX = /^([a-z][a-z-]*)(?:\([^)]*\))?!?:\s+(.+)$/;

/** A slash-joined type, as `chore/remove autotriage code` writes one. */
const SLASHED_TYPE = /^[a-z][a-z-]*\//;

/** The pull request a section's bullet shipped in: `([#10334](url))`. */
const PULL_REQUEST_LINK = /\s*\(\[#\d+\]\([^)]*\)\)$/;

/** The older sections' bare reference: `(#6670)`. */
const BARE_PULL_REQUEST = /\s*\(#\d+\)$/;

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

/**
 * A bullet as the reader gets it: a sentence, the languages a copy fix names,
 * or nothing at all for internal work.
 */
type ReaderNote = Readonly<{ text: string }> | Readonly<{ languages: readonly string[] }>;

/**
 * The reader-facing note of one bullet, or null when the bullet is internal
 * work: a type nobody sees, a repository scope from a maintenance run, the
 * workflow's own note that no change shipped, work the screen cannot show, or a
 * shipped subject that names nothing.
 */
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
  const subject = withoutPullRequest(conventional?.[2] ?? line);
  if (subject === '' || UNSEEN_WORK.some(pattern => pattern.test(subject))) {
    return null;
  }
  const languages = translationLanguagesIn(subject);
  if (languages.length > 0) {
    return { languages };
  }
  if (Object.hasOwn(UNREADABLE_NOTES, subject.toLocaleLowerCase('en'))) {
    return null;
  }
  // The notes are English commit subjects, so the English casing is the right
  // one: a Turkish device would otherwise take the leading `i` to `İ`.
  return { text: subject.charAt(0).toLocaleUpperCase('en') + subject.slice(1) };
}

/** One note into the section it belongs to: a sentence, or the languages it names. */
function applyNote(note: ReaderNote, notes: string[], languages: string[]): void {
  if ('text' in note) {
    notes.push(note.text);
    return;
  }
  for (const language of note.languages) {
    if (!languages.includes(language)) {
      languages.push(language);
    }
  }
}

/**
 * The release sections in file order, newest build first, one per version:
 * consecutive builds of one version merge into one list of notes. Everything
 * above the first `## ` heading — the document title and the maintainer note —
 * is not a section, and a version with nothing a reader can see is not one
 * either.
 */
export function changelogSections(markdown: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let version: string | null = null;
  let notes: string[] = [];
  let languages: string[] = [];

  const flush = (): void => {
    if (version !== null && (notes.length > 0 || languages.length > 0)) {
      sections.push({ version, notes, translationLanguages: languages });
    }
    version = null;
    notes = [];
    languages = [];
  };

  for (const line of markdown.split('\n')) {
    const heading = RELEASE_HEADING.exec(line);
    const next = heading === null ? null : versionOf(heading[1] ?? '');
    if (next !== null) {
      // Every store build of one version is the same release to the reader, so
      // its notes keep accumulating under the heading already on screen.
      if (next !== version) {
        flush();
      }
      version = next;
    } else if (version !== null) {
      const bullet = NOTE.exec(line);
      const note = bullet?.[1] === undefined ? null : readerFacingNote(bullet[1]);
      if (note !== null) {
        applyNote(note, notes, languages);
      }
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
