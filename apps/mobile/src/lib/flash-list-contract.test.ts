// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Dependency-contract guard for @shopify/flash-list. The agent transcript list
// depends on fixes that landed after 2.0.2 (default-disabled
// removeClippedSubviews against the Android Fabric reattachment crash, and
// stable scroll position when prepending older pages), so a silent downgrade
// back to the Expo SDK 57 recommended 2.0.2 must fail here before any build.
const EXPECTED_FLASH_LIST_VERSION = '2.3.2';

const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url));
const packageJson: {
  dependencies: Record<string, string>;
  expo: { install: { exclude: string[] } };
} = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

describe('@shopify/flash-list dependency contract', () => {
  it('pins the transcript-required version in package.json', () => {
    expect(packageJson.dependencies['@shopify/flash-list']).toBe(EXPECTED_FLASH_LIST_VERSION);
  });

  it('resolves the pinned version in the installed tree', () => {
    const installed = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL('../../node_modules/@shopify/flash-list/package.json', import.meta.url)
        ),
        'utf8'
      )
    ) as { version: string };
    expect(installed.version).toBe(EXPECTED_FLASH_LIST_VERSION);
  });

  it('keeps flash-list out of expo-managed version bumps', () => {
    // Expo SDK 57 recommends 2.0.2; the intentional 2.3.2 pin above the SDK
    // recommendation must stay in expo.install.exclude or expo install --check
    // and expo-doctor try to downgrade it back.
    expect(packageJson.expo.install.exclude).toContain('@shopify/flash-list');
  });
});
