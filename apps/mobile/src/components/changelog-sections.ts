/**
 * The bundled changelog split at its `## ` release headings, in file order.
 * The screen renders one chunk per list item so the markdown renderer parses
 * only the chunks in the list's window: `CHANGELOG.md` grows with every release
 * and the whole history parsed synchronously on open is work nobody sees.
 * Concatenating the chunks returns the source bytes unchanged.
 */
export function splitChangelogSections(markdown: string): string[] {
  return markdown.split(/^(?=## )/m);
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
