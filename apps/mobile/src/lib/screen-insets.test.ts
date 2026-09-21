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

const ENTRY_POINT = 'screen-insets.ts';
const PROFILE_SCREEN = '../components/profile-screen.tsx';

/**
 * The Profile screen's alignment path: from the line that reads
 * `useScreenSideInsets` through the line that first applies a side inset. Only
 * this path must stay free of per-platform branches. A fork elsewhere in the
 * screen — the Android sign-out confirmation, for example — is not on the
 * insets path and must not fail the guard.
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
    // The sign-out confirmation legitimately picks its dialog per platform,
    // which is not on the alignment path, so only the path from
    // `useScreenSideInsets` to the first applied side inset is held to the rule.
    expect(
      alignmentPath(profile),
      `${PROFILE_SCREEN}'s alignment path carries a per-platform branch`
    ).not.toMatch(PLATFORM_BRANCH);
  });
});
