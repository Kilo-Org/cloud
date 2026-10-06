// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Dependency-contract guard for the repository release-age policy in
// pnpm-workspace.yaml. The global minimumReleaseAge gate must stay intact, the
// container-runtime exemptions must each name one exact package@version (a
// name-only or wildcard entry would un-gate every future release), and every
// pre-existing base exclusion must survive unchanged.
const EXPECTED_MINIMUM_RELEASE_AGE_MINUTES = 6842;

const BASE_EXCLUDE_ENTRIES = [
  'tsx',
  'expo-dev-client',
  'expo-dev-launcher',
  'expo-dev-menu',
  'expo-dev-menu-interface',
  'expo-manifests',
  'expo-updates-interface',
  '@expo/schema-utils',
  '@typescript/native-preview',
  '@typescript/native-preview-darwin-arm64',
  '@typescript/native-preview-darwin-x64',
  '@typescript/native-preview-linux-arm',
  '@typescript/native-preview-linux-arm64',
  '@typescript/native-preview-linux-x64',
  '@typescript/native-preview-win32-arm64',
  '@typescript/native-preview-win32-x64',
  '@ai-sdk/anthropic',
  '@anthropic-ai/sdk',
  '@kilocode/sdk',
  'openclaw',
] as const;

// The DO-managed Cloudflare containers runtime needs wrangler 4.134.0+, and
// 4.135.0 exact-pins its own workerd/miniflare runtime, so each is exempted by
// exact version. Approved early-access exception; remove this group when 4.135.0
// matures.
const CLOUDFLARE_CONTAINER_RUNTIME_EXACT_EXCLUDE_ENTRIES = [
  'wrangler@4.135.0',
  'workerd@1.20260918.1',
  'miniflare@5.20260918.0-alpha',
  '@cloudflare/workerd-darwin-64@1.20260918.1',
  '@cloudflare/workerd-darwin-arm64@1.20260918.1',
  '@cloudflare/workerd-linux-64@1.20260918.1',
  '@cloudflare/workerd-linux-arm64@1.20260918.1',
  '@cloudflare/workerd-windows-64@1.20260918.1',
] as const;

// Three mobile pins must move without waiting out the gate: FlashList 2.3.3
// carries the EngagedIndicesTracker scroll-window fix the agent transcript list
// depends on, react-native-keyboard-controller 1.22.6 carries the
// KeyboardChatScrollView fixes the keyboard phase depends on (SDK 57 pins
// 1.21.9), and react-native-enriched-markdown 1.1.0 adds the image and code
// block press events the transcript markdown wires. One exact package@version
// each.
const MOBILE_EXACT_EXCLUDE_ENTRIES = [
  '@shopify/flash-list@2.3.3',
  'react-native-keyboard-controller@1.22.6',
  'react-native-enriched-markdown@1.1.0',
] as const;
// Exact pnpm syntax for one pinned package version: bare or @scoped name, then
// @ and a version starting with a digit. Rejects name-only entries, ranges,
// wildcards, and future-version placeholders alike.
const EXACT_VERSION_PATTERN = /^(@[^/]+\/)?[^@]+@[0-9][^@]*$/;

const workspaceYamlPath = fileURLToPath(
  new URL('../../../../pnpm-workspace.yaml', import.meta.url)
);
const workspaceYaml = readFileSync(workspaceYamlPath, 'utf8');

function parseExcludeEntries(source: string): string[] {
  const lines = source.split('\n');
  const sectionStart = lines.indexOf('minimumReleaseAgeExclude:');
  if (sectionStart === -1) {
    throw new Error('minimumReleaseAgeExclude section not found in pnpm-workspace.yaml');
  }
  const entries: string[] = [];
  for (let i = sectionStart + 1; i < lines.length; i += 1) {
    const line = lines[i];
    // A line without two-space indentation is the next top-level key and ends
    // the section; comment and blank lines inside the section are skipped.
    if (line === undefined || !line.startsWith('  ')) {
      break;
    }
    const entry = /^ {2}- (.+)$/.exec(line)?.[1];
    if (entry !== undefined) {
      entries.push(entry.trim().replace(/^'(.*)'$/, '$1'));
    }
  }
  return entries;
}

const excludeEntries = parseExcludeEntries(workspaceYaml);
const baseExcludes: readonly string[] = BASE_EXCLUDE_ENTRIES;
const newExclusions = excludeEntries.filter(entry => !baseExcludes.includes(entry));

describe('minimum release age policy contract', () => {
  it('keeps the global release-age gate at 6842 minutes', () => {
    const match = /^minimumReleaseAge: (\d+)$/m.exec(workspaceYaml);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(EXPECTED_MINIMUM_RELEASE_AGE_MINUTES);
  });

  it('excludes exactly the base list plus the container-runtime and mobile exact versions', () => {
    // Order as written: tsx, the container-runtime exemptions, then the
    // remaining base entries, then the mobile exemptions — the base list with
    // nothing dropped or changed.
    const expected = [
      BASE_EXCLUDE_ENTRIES[0],
      ...CLOUDFLARE_CONTAINER_RUNTIME_EXACT_EXCLUDE_ENTRIES,
      ...BASE_EXCLUDE_ENTRIES.slice(1),
      ...MOBILE_EXACT_EXCLUDE_ENTRIES,
    ];
    expect(excludeEntries).toEqual(expected);
  });

  it('scopes every new exclusion to one exact package@version', () => {
    expect(newExclusions).toEqual([
      ...CLOUDFLARE_CONTAINER_RUNTIME_EXACT_EXCLUDE_ENTRIES,
      ...MOBILE_EXACT_EXCLUDE_ENTRIES,
    ]);
    for (const entry of newExclusions) {
      expect(entry).toMatch(EXACT_VERSION_PATTERN);
    }
  });

  it('preserves every base exclusion unchanged', () => {
    for (const base of BASE_EXCLUDE_ENTRIES) {
      expect(excludeEntries).toContain(base);
    }
    // Base entries keep their name-only style: none of them was rewritten to
    // carry a version suffix.
    for (const entry of excludeEntries) {
      if (baseExcludes.includes(entry)) {
        expect(baseExcludes).toContain(entry);
      }
    }
  });
});
