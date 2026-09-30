// One cross-platform implementation for the new-session discard confirm.
//
// The discard confirm must behave the same on iOS and Android: the request
// names no platform, and a verification host is not a scope. `Alert.alert`'s
// `style: 'destructive'` never reaches the screen on Android (the native
// `AlertDialog` paints every button with the theme accent), so the hook renders
// the in-app `DestructiveConfirmDialog` on both platforms instead of forking.
// This suite reads the hook source in node and holds it to that: a per-platform
// branch, or a return to the native alert, fails here. The mounted suite
// (`use-new-session-discard-guard.mounted.test.tsx`) proves the rendered
// behaviour for both platform values.

// eslint-disable-next-line import/no-nodejs-modules -- vitest-only parity check, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only parity check, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = fileURLToPath(new URL('./', import.meta.url));

const GUARD = 'use-new-session-discard-guard.ts';

/**
 * A per-platform branch in shared JS: a `Platform.OS`/`Platform.select` check,
 * or an import of a platform-suffixed module.
 */
const PLATFORM_BRANCH =
  /\bPlatform\.(?:OS|select|Version)\b|from '[^']+\.(?:ios|android)'|require\('[^']+\.(?:ios|android)'\)/;

describe('new-session discard guard: one implementation for both platforms', () => {
  it('carries no per-platform branch on the discard-confirm path', () => {
    const guard = readFileSync(`${HERE}${GUARD}`, 'utf8');

    expect(guard, `${GUARD} carries a per-platform branch`).not.toMatch(PLATFORM_BRANCH);
  });

  it('renders the in-app destructive confirm instead of the native alert', () => {
    const guard = readFileSync(`${HERE}${GUARD}`, 'utf8');

    // The in-app dialog is the single implementation; a native `Alert.alert`
    // fallback would reintroduce the platform fork this test guards against.
    // Match the import and the call, not the prose that names the limitation.
    expect(guard).toMatch(/DestructiveConfirmDialog/);
    expect(guard, `${GUARD} imports react-native again`).not.toMatch(/from 'react-native'/);
    expect(guard, `${GUARD} calls the native alert again`).not.toMatch(/Alert\s*\.\s*alert\s*\(/);
  });
});
