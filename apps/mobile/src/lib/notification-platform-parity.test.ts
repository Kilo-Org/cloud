// One implementation for both platforms on the needs-input notification path.
//
// Approve, Reply, Open PR and Open session are one shared JS implementation:
// the same category contract, the same `data` payload, the same planning of the
// app-owned raise, and the same headless answer, on iOS and Android. Each
// platform only contributes the capability the other lacks — the Android
// notification channel and the iOS interruption level / entitlement. So no
// module on this path may branch on the platform, and stored state is read
// through the app's one cross-platform SecureStore entry point. This suite
// reads the shared sources in node and holds them to that: a per-platform
// branch that would ship to one platform only fails here.

// eslint-disable-next-line import/no-nodejs-modules -- vitest-only parity check, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only parity check, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const DIRECTORY = fileURLToPath(new URL('./', import.meta.url));

/**
 * The shared (non-test) modules the path runs on both platforms: raise
 * planning, category registration, response dispatch, the headless answer, the
 * deep-link routes, and the mount that posts the app-owned raise.
 */
const SHARED_MODULES = [
  'active-sessions-live-sync-mount.tsx',
  'needs-input-notification.ts',
  'notification-action-interaction.ts',
  'notification-actions.ts',
  'notification-background-task.ts',
  'notification-path.ts',
];

function sourceOf(file: string): string {
  return readFileSync(`${DIRECTORY}${file}`, 'utf8');
}

/**
 * The source with comments removed, so prose about a branch (`no Platform.OS
 * branch here`) is not read as the branch itself.
 */
function codeOf(file: string): string {
  return sourceOf(file)
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/\/\/.*$/gm, '');
}

/**
 * A per-platform branch in shared JS: a `Platform.OS`/`Platform.select` check,
 * or an import of a platform-suffixed module.
 */
const PLATFORM_BRANCH =
  /\bPlatform\.(?:OS|select|Version)\b|from '[^']+\.(?:ios|android)'|require\('[^']+\.(?:ios|android)'\)/;

describe('one implementation for both platforms on the needs-input notification path', () => {
  it('branches on the platform nowhere', () => {
    expect(SHARED_MODULES.length).toBeGreaterThan(0);
    for (const file of SHARED_MODULES) {
      expect(PLATFORM_BRANCH.test(codeOf(file)), `${file} carries a per-platform branch`).toBe(
        false
      );
    }
  });

  it('keeps a platform gate only where the platform lacks the capability, named in its comment', () => {
    // Android notification channels exist only on Android, so the two channel
    // writers in `notifications.ts` return early on iOS and each names it
    // ("No-op on iOS.") in the doc comment above it. Nothing on the path picks
    // a platform to choose behaviour.
    const source = sourceOf('notifications.ts');
    expect(source.match(/if \(Platform\.OS !== 'android'\) \{/g) ?? []).toHaveLength(2);
    expect(source.match(/No-op on iOS\./g) ?? []).toHaveLength(2);
    expect(source).not.toMatch(/Platform\.select\b|Platform\.Version\b/);
  });

  it('reads the stored user id through the one cross-platform SecureStore entry point', () => {
    const source = sourceOf('notification-action-interaction.ts');
    expect(source).toContain("from '@/lib/auth/secure-store-value'");
    expect(source, 'no direct expo-secure-store import').not.toMatch(
      /from ['"]expo-secure-store['"]/
    );
  });
});
