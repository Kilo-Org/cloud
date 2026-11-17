/**
 * The bundled changelog as a reader wants it: one item per store build, with
 * the maintainer's parts of the source file removed.
 *
 * `CHANGELOG.md` is written by the Release workflow for maintainers, not for
 * the screen. Its title and preamble say how the file is maintained, every
 * bullet is a commit subject (`fix(mobile): ...`) that ends in a link to its
 * pull request, and a section lists work no reader can see (tests, docs, CI,
 * refactors). The file is generated output whose shipped sections are already
 * part of the record, so the reader-facing shape is derived here instead of by
 * rewriting it.
 */

/**
 * One build's notes. `version` is painted above the notes the first time it
 * appears and is null while the items above still name it: the file carries a
 * section per store build, and a reader only needs the version once per run.
 */
export type ChangelogSection = Readonly<{
  /** `1.0.16`, or null when the section above it already names this version. */
  version: string | null;
  /** One sentence per change: no bullet, no commit prefix, no pull request reference. */
  notes: readonly string[];
}>;

const RELEASE_HEADING = /^## (.+)$/;
const NOTE = /^- (.+)$/;

/** `1.0.16` in `1.0.16 (build 720 iOS, 721 Android)`. */
const VERSION_PREFIX = /^\d+\.\d+\.\d+/;

/** `fix(mobile)!: ` in a commit subject: the type, its scope and the separator. */
const CONVENTIONAL_PREFIX = /^([a-z][a-z-]*)(?:\([^)]*\))?!?:\s+(.+)$/;

/** A subject that opens with a bare scope, as `(janitor/test-prune): ...` does. */
const BARE_SCOPE = /^\(/;

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
const INTERNAL_TYPES = new Set(['build', 'chore', 'ci', 'docs', 'refactor', 'style', 'test']);

/** The workflow's bodies for a section that carries no reader-facing change. */
const NO_CHANGE_NOTES = new Set([
  'Initial release: no earlier build to compare against.',
  'No user-visible changes since the previous build.',
]);

/** `1.0.16` from its heading; the heading's own words when it names no version. */
function versionOf(heading: string): string {
  const text = heading.trim();
  return VERSION_PREFIX.exec(text)?.[0] ?? text;
}

/** `subject` without the pull request reference its commit subject ended in. */
function withoutPullRequest(subject: string): string {
  const link = PULL_REQUEST_LINK.exec(subject);
  const bare = BARE_PULL_REQUEST.exec(link ? subject.slice(0, link.index) : subject);
  return (bare ? subject.slice(0, bare.index) : subject).trim();
}

/**
 * The reader-facing sentence of one bullet, or null when the bullet is internal
 * work: a type nobody sees, a repository scope from a maintenance run, or the
 * workflow's own note that no change shipped.
 */
function userFacingNote(bullet: string): string | null {
  const line = bullet.trim();
  if (NO_CHANGE_NOTES.has(line) || BARE_SCOPE.test(line) || SLASHED_TYPE.test(line)) {
    return null;
  }
  const conventional = CONVENTIONAL_PREFIX.exec(line);
  const type = conventional?.[1];
  if (type !== undefined && INTERNAL_TYPES.has(type)) {
    return null;
  }
  const subject = withoutPullRequest(conventional?.[2] ?? line);
  if (subject === '') {
    return null;
  }
  return subject.charAt(0).toUpperCase() + subject.slice(1);
}

/**
 * The release sections in file order, newest build first. Everything above the
 * first `## ` heading — the document title and the maintainer note — is not a
 * section. A section whose bullets are all internal work is not returned: it
 * would be a heading with nothing under it.
 */
export function changelogSections(markdown: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let version: string | null = null;
  let notes: string[] = [];
  let namedVersion: string | null = null;

  const flush = (): void => {
    if (version === null || notes.length === 0) {
      return;
    }
    const namesIt = version !== namedVersion;
    namedVersion = version;
    sections.push({ version: namesIt ? version : null, notes });
  };

  for (const line of markdown.split('\n')) {
    const heading = RELEASE_HEADING.exec(line);
    if (heading) {
      flush();
      version = versionOf(heading[1] ?? '');
      notes = [];
      continue;
    }
    if (version === null) {
      continue;
    }
    const bullet = NOTE.exec(line);
    const note = bullet?.[1] === undefined ? null : userFacingNote(bullet[1]);
    if (note !== null) {
      notes.push(note);
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
 * this build compiled carry the previous release: the screen tells the reader
 * instead of presenting the previous release as this version's news.
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
