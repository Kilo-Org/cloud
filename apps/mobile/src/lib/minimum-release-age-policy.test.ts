// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Dependency-contract guard for the repository release-age policy in
// pnpm-workspace.yaml. The global minimumReleaseAge gate must stay intact, the
// SDK 57 alignment exemptions must each name one exact package@version (a
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

// The exact versions the Expo SDK 57 aligned graph installs (verified against
// pnpm-lock.yaml): the four 2026-09-08 patch releases `expo install --check`
// expects plus the transitive resolutions blocked by the 6842-minute gate.
const SDK_57_EXACT_EXCLUDE_ENTRIES = [
  'expo@57.0.21',
  '@expo/ui@57.0.17',
  'expo-router@57.0.20',
  'expo-widgets@57.0.18',
  'babel-preset-expo@57.0.11',
  'expo-modules-core@57.0.17',
  'expo-modules-jsi@57.1.0',
  '@expo/cli@57.0.23',
  '@expo/metro-file-map@57.0.3',
  'expo-glass-effect@57.0.2',
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

  it('excludes exactly the base list plus the ten SDK 57 exact versions', () => {
    // Order as written: tsx, the ten aligned-version exemptions, then the
    // remaining base entries — the base list with nothing dropped or changed.
    const expected = [
      BASE_EXCLUDE_ENTRIES[0],
      ...SDK_57_EXACT_EXCLUDE_ENTRIES,
      ...BASE_EXCLUDE_ENTRIES.slice(1),
    ];
    expect(excludeEntries).toEqual(expected);
  });

  it('scopes every new exclusion to one exact package@version', () => {
    expect(newExclusions).toEqual([...SDK_57_EXACT_EXCLUDE_ENTRIES]);
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
