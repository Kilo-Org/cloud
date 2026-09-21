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
 * The Profile screen's side-inset alignment path: the lines that read the
 * insets and the style they build. The screen legitimately forks on the
 * platform elsewhere (its Android-only in-app sign-out confirmation, covered by
 * `profile-screen.signout.mounted.test.tsx`), but no line on the alignment path
 * that applies the insets may.
 */
function alignmentPath(sourceText: string): string {
  return sourceText
    .split('\n')
    .filter(line => /useScreenSideInsets|scrollStyle/.test(line))
    .join('\n');
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
    expect(
      alignmentPath(profile),
      `${PROFILE_SCREEN} forks on the platform on its side-inset alignment path`
    ).not.toMatch(PLATFORM_BRANCH);
  });
});
