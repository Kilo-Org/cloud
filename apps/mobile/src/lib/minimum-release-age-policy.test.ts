// eslint-disable-next-line import/no-nodejs-modules -- Node-only configuration policy test.
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- Node-only configuration policy test.
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const LEGACY_NAME_EXEMPTIONS = [
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
];

const workspaceYaml = readFileSync(
  fileURLToPath(new URL('../../../../pnpm-workspace.yaml', import.meta.url)),
  'utf8'
);
const lines = workspaceYaml.split('\n');
const sectionStart = lines.indexOf('minimumReleaseAgeExclude:');
if (sectionStart === -1) throw new Error('Missing release-age exemption configuration');
const exemptions: string[] = [];
for (const line of lines.slice(sectionStart + 1)) {
  if (!line.startsWith('  ')) break;
  const entry = /^ {2}- (.+)$/.exec(line)?.[1];
  if (entry !== undefined) exemptions.push(entry.trim().replace(/^'(.*)'$/, '$1'));
}

// Names can remain broad only when the existing policy explicitly permits them.
const EXACT_PACKAGE_VERSION =
  /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/;

describe('minimum release age security policy', () => {
  it('retains the global release-age quarantine', () => {
    const configuredAge = /^minimumReleaseAge: (\d+)$/m.exec(workspaceYaml)?.[1];
    expect(Number(configuredAge)).toBe(6842);
  });

  it('requires exact versions for exemptions outside the legacy name allowlist', () => {
    for (const exemption of exemptions) {
      if (!LEGACY_NAME_EXEMPTIONS.includes(exemption)) {
        expect(exemption).toMatch(EXACT_PACKAGE_VERSION);
      }
    }
  });

  it('preserves the existing legacy exemptions', () => {
    for (const name of LEGACY_NAME_EXEMPTIONS) expect(exemptions).toContain(name);
  });
});
