import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeAgentId, workspaceFromName } from './agent-id';

// PARITY: the controller owns the authoritative normalizeAgentId
// (services/kiloclaw/controller/src/openclaw-agent-config.ts) and this is a
// re-declared mirror (the architecture wall blocks importing controller code
// into apps/web). Instead of two hand-maintained corpora that can silently
// drift, BOTH suites load the SAME shared corpus file (the controller's
// openclaw-agent-config.test.ts reads it too). A single source of truth means
// changing either implementation's output for a listed input fails that side,
// and changing the rule requires updating the shared file plus both impls.
const corpusPath = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'services',
  'kiloclaw',
  'controller',
  'src',
  'agent-id-corpus.json'
);
const NORMALIZE_AGENT_ID_CORPUS = (
  JSON.parse(readFileSync(corpusPath, 'utf8')) as {
    cases: ReadonlyArray<{ input: string; expected: string }>;
  }
).cases;

describe('normalizeAgentId', () => {
  it.each(NORMALIZE_AGENT_ID_CORPUS)(
    'normalizes $input -> $expected (shared parity corpus)',
    ({ input, expected }) => {
      expect(normalizeAgentId(input)).toBe(expected);
    }
  );

  it('keeps underscore and hyphen names distinct (no workspace collision)', () => {
    expect(normalizeAgentId('foo_bar')).not.toBe(normalizeAgentId('foo-bar'));
  });

  it('caps at 64 chars', () => {
    expect(normalizeAgentId('a'.repeat(100))).toHaveLength(64);
  });
});

describe('workspaceFromName', () => {
  it('derives the path from the normalized id', () => {
    expect(workspaceFromName('Research')).toBe('/root/.openclaw/workspace-research');
    expect(workspaceFromName('foo_bar')).toBe('/root/.openclaw/workspace-foo_bar');
  });
});
