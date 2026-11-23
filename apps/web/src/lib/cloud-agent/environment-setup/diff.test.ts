import { buildSetupRunDiff, type SetupRunConfigView } from './diff';

function configView(overrides: Partial<SetupRunConfigView> = {}): SetupRunConfigView {
  return {
    script: 'npm install',
    plainVars: { NODE_ENV: 'development' },
    secretKeys: ['API_TOKEN'],
    sandboxAllocation: 'standard-2',
    egressMode: 'unrestricted',
    egressAllowlist: [],
    requiredHosts: [],
    repositories: ['Kilo-Org/cloud'],
    ...overrides,
  };
}

describe('buildSetupRunDiff', () => {
  it('reports added, removed and changed plain variables', () => {
    const diff = buildSetupRunDiff(
      configView({ plainVars: { KEPT: 'one', CHANGED: 'before', REMOVED: 'gone' } }),
      configView({ plainVars: { KEPT: 'one', CHANGED: 'after', ADDED: 'new' } })
    );

    expect(diff.plainVarsAdded).toEqual(['ADDED']);
    expect(diff.plainVarsRemoved).toEqual(['REMOVED']);
    expect(diff.plainVarsChanged).toEqual(['CHANGED']);
  });

  it('reports secret keys only and never includes secret values', () => {
    const diff = buildSetupRunDiff(
      configView({ secretKeys: ['REMOVED_SECRET', 'KEPT_SECRET', 'CHANGED_SECRET'] }),
      configView({ secretKeys: ['KEPT_SECRET', 'CHANGED_SECRET', 'ADDED_SECRET'] })
    );

    expect(diff.secretKeysAdded).toEqual(['ADDED_SECRET']);
    expect(diff.secretKeysRemoved).toEqual(['REMOVED_SECRET']);
    expect(JSON.stringify(diff)).not.toContain('secret-value');
  });

  it('reports an egress change', () => {
    const diff = buildSetupRunDiff(
      configView({ egressMode: 'unrestricted', egressAllowlist: [] }),
      configView({ egressMode: 'allowlist', egressAllowlist: ['b.example.com', 'a.example.com'] })
    );

    expect(diff.egress).toEqual({
      before: { mode: 'unrestricted', allowlist: [] },
      after: { mode: 'allowlist', allowlist: ['a.example.com', 'b.example.com'] },
    });
  });

  it('treats a null egress mode as unrestricted', () => {
    const diff = buildSetupRunDiff(
      configView({ egressMode: null }),
      configView({ egressMode: 'unrestricted' })
    );

    expect(diff.egress).toBeNull();
  });

  it('reports required host changes', () => {
    const diff = buildSetupRunDiff(
      configView({ requiredHosts: ['old.example.com', 'kept.example.com'] }),
      configView({ requiredHosts: ['kept.example.com', 'new.example.com'] })
    );

    expect(diff.requiredHostsAdded).toEqual(['new.example.com']);
    expect(diff.requiredHostsRemoved).toEqual(['old.example.com']);
  });

  it('reports script, sandbox, and repository changes', () => {
    const diff = buildSetupRunDiff(
      configView({ script: 'old', sandboxAllocation: 'standard-2' }),
      configView({
        script: 'new',
        sandboxAllocation: 'standard-4',
        repositories: ['Kilo-Org/cloud', 'Kilo-Org/docs'],
      })
    );

    expect(diff.scriptChanged).toBe(true);
    expect(diff.scriptBefore).toBe('old');
    expect(diff.scriptAfter).toBe('new');
    expect(diff.sandboxAllocation).toEqual({ before: 'standard-2', after: 'standard-4' });
    expect(diff.repositoriesAdded).toEqual(['Kilo-Org/docs']);
    expect(diff.repositoriesRemoved).toEqual([]);
  });

  it('treats every after value as added when there is no before configuration', () => {
    const diff = buildSetupRunDiff(
      null,
      configView({
        plainVars: { NEW: 'value' },
        secretKeys: ['NEW_SECRET'],
        requiredHosts: ['new.example.com'],
        repositories: ['Kilo-Org/new'],
      })
    );

    expect(diff.scriptChanged).toBe(true);
    expect(diff.plainVarsAdded).toEqual(['NEW']);
    expect(diff.secretKeysAdded).toEqual(['NEW_SECRET']);
    expect(diff.requiredHostsAdded).toEqual(['new.example.com']);
    expect(diff.repositoriesAdded).toEqual(['Kilo-Org/new']);
  });

  it('reports no change for identical configurations', () => {
    const diff = buildSetupRunDiff(configView(), configView());

    expect(diff.scriptChanged).toBe(false);
    expect(diff.plainVarsAdded).toEqual([]);
    expect(diff.plainVarsRemoved).toEqual([]);
    expect(diff.plainVarsChanged).toEqual([]);
    expect(diff.secretKeysAdded).toEqual([]);
    expect(diff.secretKeysRemoved).toEqual([]);
    expect(diff.sandboxAllocation).toBeNull();
    expect(diff.egress).toBeNull();
    expect(diff.requiredHostsAdded).toEqual([]);
    expect(diff.requiredHostsRemoved).toEqual([]);
    expect(diff.repositoriesAdded).toEqual([]);
    expect(diff.repositoriesRemoved).toEqual([]);
  });
});
