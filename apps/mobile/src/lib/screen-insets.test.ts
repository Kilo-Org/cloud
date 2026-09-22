// One cross-platform implementation for the screen's landscape side insets.
//
// `screen-insets.ts` is the app's single entry point for screen safe-area
// insets: it reads `react-native-safe-area-context`, whose left/right contract
// is the same on iOS (notch/Dynamic Island) and Android (display cutout). The
// Profile screen reads its side insets from `useScreenSideInsets` instead of
// importing the native module itself, so no line on that alignment path may
// fork on the platform. This suite reads the shared sources in node and holds
// them to that: a per-platform branch that would ship to one platform only
// fails here.

// eslint-disable-next-line import/no-nodejs-modules -- vitest-only parity check, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only parity check, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = fileURLToPath(new URL('./', import.meta.url));

function source(relativePath: string): string {
  return readFileSync(`${HERE}${relativePath}`, 'utf8');
}

/**
 * A per-platform branch in shared JS: a `Platform.OS`/`Platform.select` check,
 * or an import of a platform-suffixed module.
 */
const PLATFORM_BRANCH =
  /\bPlatform\.(?:OS|select|Version)\b|from '[^']+\.(?:ios|android)'|require\('[^']+\.(?:ios|android)'\)/;

/** A second, direct import of the native safe-area module outside the entry point. */
const SAFE_AREA_MODULE = /react-native-safe-area-context/;

/**
 * The lines that carry a screen's own inset handling: the entry-point import
 * and hook call, plus every line that consumes the values the hook returns. The
 * platform check covers the alignment path this entry point owns, not every
 * line of the file: a screen may legitimately fork on the platform elsewhere,
 * and the Profile screen keeps its sign-out confirmation on the shared
 * `Alert.alert` for both platforms.
 *
 * The Profile screen applies its side insets as
 * `{ marginLeft: left, marginRight: right }` and hands that style on; keying on
 * `inset` alone would drop those lines, so a platform fork on them would slip
 * past. Match the values the entry point hands out as well as its name.
 */
const INSET_ALIGNMENT_LINE = /inset|\bleft\b|\bright\b|\bscrollStyle\b/i;

function insetAlignmentLines(fileSource: string): string {
  return fileSource
    .split('\n')
    .filter(line => INSET_ALIGNMENT_LINE.test(line))
    .join('\n');
}

const ENTRY_POINT = 'screen-insets.ts';
const PROFILE_SCREEN = '../components/profile-screen.tsx';

/**
 * The Profile screen's alignment path: from the line that reads
 * `useScreenSideInsets` through the line that first applies a side inset. Only
 * this path must stay free of per-platform branches. A fork elsewhere in the
 * screen is not on the insets path and must not fail the guard.
 */
function alignmentPath(profileSource: string): string {
  const lines = profileSource.split('\n');
  const start = lines.findIndex(line => line.includes('useScreenSideInsets()'));
  if (start === -1) {
    throw new Error(`${PROFILE_SCREEN} does not read its side insets from ${ENTRY_POINT}`);
  }
  const end = lines.findIndex(
    (line, index) => index >= start && /margin(?:Left|Right|Start|End)/.test(line)
  );
  if (end === -1) {
    // Naming the insets differently, or applying them as padding, would shrink
    // the scanned path to its first line and leave the guard passing on nothing.
    throw new Error(
      `${PROFILE_SCREEN} applies its side insets without a margin declaration; update this guard`
    );
  }
  return lines.slice(start, end + 1).join('\n');
}

describe('screen side insets: one implementation for both platforms', () => {
  it('reads the native safe-area module only in the entry point, with no platform branch', () => {
    const entry = source(ENTRY_POINT);
    expect(entry).toMatch(SAFE_AREA_MODULE);
    expect(entry, `${ENTRY_POINT} carries a per-platform branch`).not.toMatch(PLATFORM_BRANCH);
  });

  it('has the Profile screen read its side insets from the entry point', () => {
    const profile = source(PROFILE_SCREEN);
    expect(profile).toMatch(/from '@\/lib\/screen-insets'/);
    expect(profile, `${PROFILE_SCREEN} imports the native safe-area module again`).not.toMatch(
      SAFE_AREA_MODULE
    );
    // The screen carries no platform branch at all: sign-out confirms through
    // the one shared alert on both platforms, so the insets path — and every
    // other line — stays a single implementation. Only the lines that carry the
    // insets are read below as the alignment path; a fork elsewhere in the
    // screen is not on the insets path and must not fail this guard.
    expect(
      insetAlignmentLines(profile),
      `${PROFILE_SCREEN} carries a per-platform branch on its inset path`
    ).not.toMatch(PLATFORM_BRANCH);
    // Both readers guard the same path: `insetAlignmentLines` keys on every
    // line that touches an inset value, while `alignmentPath` walks from the
    // hook call to the line that first applies a side inset. Keep both so a
    // fork is caught whichever way the insets are spelled.
    expect(
      alignmentPath(profile),
      `${PROFILE_SCREEN}'s alignment path carries a per-platform branch`
    ).not.toMatch(PLATFORM_BRANCH);
  });

  it('keeps the lines that apply the insets, not only the lines that name them', () => {
    // The Profile screen applies its side insets without naming them: the
    // applying line carries neither `inset` nor the hook. A filter keyed on the
    // word alone would drop it and let a platform fork on it through.
    expect(
      insetAlignmentLines(source(PROFILE_SCREEN)),
      `${PROFILE_SCREEN} applies its side insets on a line the guard does not read`
    ).toMatch(/\{\s*marginLeft: left, marginRight: right\s*\}/);

    const applied = [
      'const { left, right } = useScreenSideInsets();',
      'const scrollStyle = { marginLeft: left, marginRight: right };',
    ].join('\n');
    expect(insetAlignmentLines(applied)).toMatch(/marginLeft: left, marginRight: right/);
    expect(
      insetAlignmentLines(
        `${applied}\nconst forked = Platform.select({ ios: scrollStyle, android: scrollStyle });`
      ),
      'a platform fork on the line applying the side insets went unnoticed'
    ).toMatch(PLATFORM_BRANCH);
  });
});
