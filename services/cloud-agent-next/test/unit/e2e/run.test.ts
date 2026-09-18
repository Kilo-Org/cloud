import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildDeployedConfig,
  exitCodeFor,
  exitCodeForResults,
  parseArgs,
  requireScenarioApi,
  resolveLocalDefinition,
  resultOutcome,
} from '../../e2e/run.js';
import type { LifecycleArgs, LifecycleResult } from '../../e2e/lifecycle.js';
import type { ScenarioEnvironment } from '../../e2e/scenario-capabilities.js';
import type { SharedScenario } from '../../e2e/scenarios-shared.js';

describe('run timeout option', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts an overall timeout only for file-state scenarios', () => {
    expect(parseArgs(['--timeout-ms=1234', 'cold-resume', '_'])).toMatchObject({
      lifecycle: 'cold-resume',
      timeoutMs: 1234,
    });
  });

  it('accepts an overall timeout for a shared scenario', () => {
    expect(parseArgs(['--timeout-ms=300000', 'cold-hot', 'echo:hi'])).toMatchObject({
      lifecycle: 'cold-hot',
      timeoutMs: 300000,
    });
  });

  it('accepts an overall timeout for a scenario moved into the shared registry', () => {
    expect(parseArgs(['--timeout-ms=1234', 'hot', 'echo:hi'])).toMatchObject({
      lifecycle: 'hot',
      timeoutMs: 1234,
    });
  });

  it('rejects timeout overrides for legacy scenarios', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(parseArgs(['--timeout-ms=1234', 'worktree-shared', '_'])).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--timeout-ms is only supported'));
  });
});

describe('requireScenarioApi (matrix fail-fast contract)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const stubExit = () => vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

  it('exits 2 with the resolver message for a matrix request that conflicts with the pin', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = stubExit();

    requireScenarioApi({ name: 'callback-completion', defaultApi: 'legacy' }, 'unified');

    expect(exit).toHaveBeenCalledWith(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('requires the legacy API'));
  });

  it('returns the resolved API for non-conflicting matrix requests so the run continues', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = stubExit();

    expect(requireScenarioApi({ name: 'cold-hot' }, undefined)).toBe('unified');
    expect(requireScenarioApi({ name: 'cold-hot' }, 'legacy')).toBe('legacy');
    expect(
      requireScenarioApi({ name: 'callback-completion', defaultApi: 'legacy' }, undefined)
    ).toBe('legacy');
    expect(
      requireScenarioApi({ name: 'callback-completion', defaultApi: 'legacy' }, 'legacy')
    ).toBe('legacy');

    expect(exit).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe('resolveLocalDefinition', () => {
  const shared: SharedScenario = {
    name: 'worktree-chat',
    requires: ['sessionSandbox'],
    defaultConversation: '_',
    run: async () => scenarioResult({ name: 'worktree-chat' }),
  };

  it('resolves a shared-only name to its shared definition', () => {
    expect(
      resolveLocalDefinition({
        lifecycle: 'worktree-chat',
        localScenarios: {},
        sharedScenarios: { 'worktree-chat': shared },
      })
    ).toBe(shared);
  });

  it('wraps a local-only name with no capability requirements', async () => {
    const localRun = vi.fn(async () => scenarioResult({ name: 'cold-resume' }));
    const definition = resolveLocalDefinition({
      lifecycle: 'cold-resume',
      localScenarios: { 'cold-resume': localRun },
      sharedScenarios: {},
    });

    expect(definition).toMatchObject({
      name: 'cold-resume',
      requires: [],
      defaultConversation: '_',
    });
    if (!definition) throw new Error('expected a wrapped local definition');
    const result = await definition.run({} as LifecycleArgs, {} as ScenarioEnvironment);
    expect(localRun).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ name: 'cold-resume' });
  });

  it('prefers the shared definition when a name exists in both', () => {
    const localRun = vi.fn(async () => scenarioResult({ name: 'cold-hot' }));
    expect(
      resolveLocalDefinition({
        lifecycle: 'worktree-chat',
        localScenarios: { 'worktree-chat': localRun },
        sharedScenarios: { 'worktree-chat': shared },
      })
    ).toBe(shared);
  });

  it('returns null for a name in neither registry', () => {
    expect(
      resolveLocalDefinition({ lifecycle: 'nope', localScenarios: {}, sharedScenarios: {} })
    ).toBeNull();
  });
});

function scenarioResult(overrides: Partial<LifecycleResult>): LifecycleResult {
  return {
    name: 'probe',
    conversation: '_',
    ok: true,
    message: 'x',
    events: [],
    durationMs: 0,
    ...overrides,
  };
}

describe('resultOutcome', () => {
  it('classifies a pass', () => {
    expect(resultOutcome(scenarioResult({ ok: true }))).toBe('pass');
  });

  it('classifies a failure', () => {
    expect(resultOutcome(scenarioResult({ ok: false }))).toBe('failure');
  });

  it('classifies a not-ok, unsupported result as unsupported', () => {
    expect(resultOutcome(scenarioResult({ ok: false, unsupported: true }))).toBe('unsupported');
  });

  it('treats an explicit unsupported: false as a failure', () => {
    expect(resultOutcome(scenarioResult({ ok: false, unsupported: false }))).toBe('failure');
  });
});

describe('exitCodeFor', () => {
  it('returns 0 for a pass', () => {
    expect(exitCodeFor(scenarioResult({ ok: true }))).toBe(0);
  });

  it('returns 2 for unsupported', () => {
    expect(exitCodeFor(scenarioResult({ ok: false, unsupported: true }))).toBe(2);
  });

  it('returns 1 for a failure', () => {
    expect(exitCodeFor(scenarioResult({ ok: false }))).toBe(1);
  });
});

describe('exitCodeForResults', () => {
  const pass = scenarioResult({ name: 'pass', ok: true });
  const failure = scenarioResult({ name: 'failure', ok: false });
  const unsupported = scenarioResult({ name: 'unsupported', ok: false, unsupported: true });

  it('returns 0 for an empty set', () => {
    expect(exitCodeForResults([])).toBe(0);
  });

  it('returns 0 when every scenario passed', () => {
    expect(exitCodeForResults([pass, { ...pass, name: 'pass-2' }])).toBe(0);
  });

  it('returns 2 when only unsupported scenarios are present', () => {
    expect(exitCodeForResults([pass, unsupported])).toBe(2);
  });

  it('returns 1 for a mixed failure and unsupported set (failure wins)', () => {
    expect(exitCodeForResults([unsupported, failure])).toBe(1);
  });

  it('returns 1 when a failure accompanies passes', () => {
    expect(exitCodeForResults([pass, failure, unsupported])).toBe(1);
  });
});

describe('buildDeployedConfig', () => {
  const auth = {
    token: 'deployed-token-value',
    identity: { userId: 'usr_deployed', email: 'deployed@example.test' },
  };
  const env = {
    workerUrl: 'https://worker.example.test',
    backendUrl: 'https://api.kilo.ai',
    fakeLlmUrl: 'https://fake.example.test',
    authFile: '/tmp/auth.json',
    fakeLlmAdminToken: 'admin-token',
    e2eInternalApiSecret: 'e2e-internal-secret-0123456789',
    auth,
  };

  it('uses the bearer token, no nextAuthSecret, and identity-only user', () => {
    const config = buildDeployedConfig(env, auth);

    // Never assert on the token value itself: it must not reach assertion output.
    expect(config.bearerToken).toBeDefined();
    expect(config.nextAuthSecret).toBeUndefined();
    expect('expectControlPlane' in config).toBe(false);
    expect(config.user).not.toHaveProperty('api_token_pepper');
    expect(config.user).toEqual({ id: 'usr_deployed', email: 'deployed@example.test' });
  });

  it('carries the resolved e2e internal secret for prepare and the surface', () => {
    const config = buildDeployedConfig(env, auth);
    expect(config.internalApiSecret).toBe('e2e-internal-secret-0123456789');
  });

  it('omits email when the deployed identity does not carry one', () => {
    const config = buildDeployedConfig(env, {
      token: 'deployed-token-value',
      identity: { userId: 'usr_deployed', email: undefined },
    });

    expect(config.user).toEqual({ id: 'usr_deployed' });
    expect('email' in config.user).toBe(false);
  });
});
