import { normalizeAgentId, workspaceFromName } from './agent-id';

// PARITY: the controller owns the authoritative normalizeAgentId
// (services/kiloclaw/controller/src/openclaw-agent-config.ts) and asserts the
// same input→output corpus in openclaw-agent-config.test.ts. The architecture
// wall prevents sharing one module, so these two test corpora are the drift
// guard — if either implementation changes, keep both corpora in sync.

describe('normalizeAgentId', () => {
  it('maps empty / whitespace-only to main', () => {
    expect(normalizeAgentId('')).toBe('main');
    expect(normalizeAgentId('   ')).toBe('main');
  });

  it('lowercases already-valid ids and preserves underscores/hyphens', () => {
    expect(normalizeAgentId('research')).toBe('research');
    expect(normalizeAgentId('Research')).toBe('research');
    expect(normalizeAgentId('foo_bar')).toBe('foo_bar');
    expect(normalizeAgentId('foo-bar')).toBe('foo-bar');
  });

  it('keeps underscore and hyphen names distinct (no workspace collision)', () => {
    expect(normalizeAgentId('foo_bar')).not.toBe(normalizeAgentId('foo-bar'));
  });

  it('collapses invalid chars to single hyphens and trims edges', () => {
    expect(normalizeAgentId('My Agent!')).toBe('my-agent');
    expect(normalizeAgentId('  spaces  here ')).toBe('spaces-here');
    expect(normalizeAgentId('a@@@b')).toBe('a-b');
  });

  it('caps at 64 chars', () => {
    expect(normalizeAgentId('a'.repeat(100))).toHaveLength(64);
  });

  it('falls back to main when nothing usable remains', () => {
    expect(normalizeAgentId('@@@')).toBe('main');
  });
});

describe('workspaceFromName', () => {
  it('derives the path from the normalized id', () => {
    expect(workspaceFromName('Research')).toBe('/root/.openclaw/workspace-research');
    expect(workspaceFromName('foo_bar')).toBe('/root/.openclaw/workspace-foo_bar');
  });
});
