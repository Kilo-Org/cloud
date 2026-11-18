import { execFileSync } from 'node:child_process';
import { describe, expect, it } from '@jest/globals';
import {
  hasEnvironmentFormChanges,
  buildEgressPolicy,
  toEnvironmentCommands,
  toEnvironmentScript,
  toNetworkAccessDraft,
  type NetworkAccessDraft,
} from './environment-form';

describe('single environment script', () => {
  it('saves one multiline script and removes an empty script', () => {
    expect(toEnvironmentCommands('  pnpm install\npnpm build\n')).toEqual([
      'pnpm install\npnpm build',
    ]);
    expect(toEnvironmentCommands(' \n ')).toEqual([]);
    expect(toEnvironmentScript([])).toBe('');
    expect(toEnvironmentScript(['echo ready'])).toBe('echo ready');
  });

  it('preserves legacy script scopes, quoting, and explicit exits', () => {
    const script = toEnvironmentScript([
      "export LEGACY_SCOPE=first; printf '%s' \"it's working\"; exit 0",
      'printf "|%s" "${LEGACY_SCOPE-unset}"',
    ]);
    expect(execFileSync('bash', ['-e', '-o', 'pipefail', '-c', script], { encoding: 'utf8' })).toBe(
      "it's working|unset"
    );
    expect(toEnvironmentCommands(script)).toHaveLength(1);
  });

  it('stops after a failure in a legacy script', () => {
    const script = toEnvironmentScript(['false | cat', 'printf should-not-run']);
    try {
      execFileSync('bash', ['-e', '-o', 'pipefail', '-c', script], { encoding: 'utf8' });
      throw new Error('Expected the setup script to fail');
    } catch (error) {
      expect(error).toMatchObject({ status: 1, stdout: '' });
    }
  });
});

describe('hasEnvironmentFormChanges', () => {
  const saved = {
    name: 'Saved environment',
    script: toEnvironmentScript(['export A=1', 'echo "$A"']),
    startScript: '',
    variablesText: 'TOKEN=<unchanged>\nPLAIN="saved"',
    sandboxAllocation: 'cloudflare-single',
    networkAccess: { mode: 'full', domains: '' } satisfies NetworkAccessDraft,
  };

  test('allows a build when the legacy script and secret markers stay untouched', () => {
    expect(hasEnvironmentFormChanges(saved, { ...saved })).toBe(false);
  });

  test.each([
    { name: 'Renamed environment' },
    { script: 'pnpm install' },
    { startScript: 'docker compose up -d' },
    { variablesText: 'TOKEN="replacement"' },
    { variablesText: 'PLAIN="saved"' },
    { variablesText: 'TOKEN=<unchanged>\nPLAIN="changed"' },
    { variablesText: 'TOKEN="unterminated' },
    { sandboxAllocation: null },
    { networkAccess: { mode: 'none', domains: '' } satisfies NetworkAccessDraft },
    {
      networkAccess: {
        mode: 'limited',
        domains: 'registry.npmjs.org',
      } satisfies NetworkAccessDraft,
    },
  ])('blocks a build while the editor contains unsaved changes: %j', change => {
    expect(hasEnvironmentFormChanges(saved, { ...saved, ...change })).toBe(true);
  });

  test('allows a build after reverting the edits', () => {
    const draft = { ...saved, script: 'changed' };
    expect(hasEnvironmentFormChanges(saved, draft)).toBe(true);
    draft.script = saved.script;
    expect(hasEnvironmentFormChanges(saved, draft)).toBe(false);
  });

  test('allows a build after reverting a name-only edit', () => {
    const draft = { ...saved, name: 'Renamed environment' };
    expect(hasEnvironmentFormChanges(saved, draft)).toBe(true);
    draft.name = saved.name;
    expect(hasEnvironmentFormChanges(saved, draft)).toBe(false);
  });

  test.each(['none', 'full'] as const)(
    'ignores hidden domain edits after returning to %s',
    mode => {
      const baseline = { ...saved, networkAccess: { mode, domains: '' } };
      const draft = {
        ...baseline,
        networkAccess: { mode: 'limited', domains: 'api.example.com' } as NetworkAccessDraft,
      };
      expect(hasEnvironmentFormChanges(baseline, draft)).toBe(true);
      draft.networkAccess.mode = mode;
      expect(hasEnvironmentFormChanges(baseline, draft)).toBe(false);
    }
  );

  test('detects domain edits while Limited access remains selected', () => {
    const baseline = {
      ...saved,
      networkAccess: { mode: 'limited', domains: 'api.example.com' } satisfies NetworkAccessDraft,
    };
    expect(
      hasEnvironmentFormChanges(baseline, {
        ...baseline,
        networkAccess: { mode: 'limited', domains: 'registry.npmjs.org' },
      })
    ).toBe(true);
  });
});

describe('environment network access', () => {
  const full: NetworkAccessDraft = { mode: 'full', domains: '' };
  const none: NetworkAccessDraft = { mode: 'none', domains: '' };

  it('reads legacy and saved policies into compact choices', () => {
    expect(toNetworkAccessDraft(null, null)).toEqual(full);
    expect(toNetworkAccessDraft('unrestricted', null)).toEqual(full);
    expect(toNetworkAccessDraft('allowlist', [])).toEqual(none);
    expect(toNetworkAccessDraft('allowlist', ['registry.npmjs.org', 'api.example.com'])).toEqual({
      mode: 'limited',
      domains: 'registry.npmjs.org\napi.example.com',
    });
  });

  it('maps None, Limited, and Full to the shared policy', () => {
    expect(buildEgressPolicy(none, full)).toEqual({
      policy: { egressMode: 'allowlist', egressAllowlist: [] },
      error: null,
    });
    expect(buildEgressPolicy({ mode: 'limited', domains: 'registry.npmjs.org' }, full)).toEqual({
      policy: { egressMode: 'allowlist', egressAllowlist: ['registry.npmjs.org'] },
      error: null,
    });
    expect(buildEgressPolicy(full, none)).toEqual({
      policy: { egressMode: 'unrestricted' },
      error: null,
    });
  });

  it('normalizes domains with the shared schema and ignores blank lines', () => {
    const result = buildEgressPolicy(
      {
        mode: 'limited',
        domains: '  API.Example.com. \n\n registry.npmjs.org \napi.example.com',
      },
      full
    );
    expect(result.error).toBeNull();
    expect(result.policy).toEqual({
      egressMode: 'allowlist',
      egressAllowlist: ['api.example.com', 'registry.npmjs.org'],
    });
  });

  it('requires a domain for Limited access', () => {
    expect(buildEgressPolicy({ mode: 'limited', domains: ' \n ' }, full).error).toMatch(
      /at least one domain/
    );
  });

  it('rejects invalid hostnames and lists above the submitted limit', () => {
    expect(
      buildEgressPolicy({ mode: 'limited', domains: 'https://example.com/path' }, full).error
    ).toMatch(/exact ASCII hostname/);

    const atLimit = Array.from({ length: 100 }, () => 'example.com').join('\n');
    expect(buildEgressPolicy({ mode: 'limited', domains: atLimit }, full).policy).toEqual({
      egressMode: 'allowlist',
      egressAllowlist: ['example.com'],
    });

    const overLimit = Array.from({ length: 101 }, () => 'example.com').join('\n');
    expect(buildEgressPolicy({ mode: 'limited', domains: overLimit }, full).error).toMatch(
      /Add no more than 100 domains/
    );
  });

  it('reports an overlong hostname as a hostname error', () => {
    const domains = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`;
    expect(buildEgressPolicy({ mode: 'limited', domains }, full).error).toMatch(
      /exact ASCII hostname/
    );
  });

  it('omits untouched policies and hidden domain text', () => {
    expect(buildEgressPolicy(full, full)).toEqual({ error: null });
    expect(buildEgressPolicy(none, none)).toEqual({ error: null });
    expect(buildEgressPolicy({ mode: 'none', domains: 'hidden.example.com' }, none)).toEqual({
      error: null,
    });
    expect(buildEgressPolicy({ mode: 'full', domains: 'hidden.example.com' }, full)).toEqual({
      error: null,
    });

    const saved = toNetworkAccessDraft('allowlist', ['api.example.com', 'registry.npmjs.org']);
    expect(
      buildEgressPolicy(
        { mode: 'limited', domains: ' registry.npmjs.org \napi.example.com' },
        saved
      )
    ).toEqual({ error: null });
    expect(buildEgressPolicy({ mode: 'none', domains: saved.domains }, saved)).toEqual({
      policy: { egressMode: 'allowlist', egressAllowlist: [] },
      error: null,
    });
  });
});
