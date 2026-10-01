import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  interruptSession: vi.fn(
    async (_config: unknown, _sessionId: string, _signal?: AbortSignal): Promise<void> => {}
  ),
  deleteSession: vi.fn(
    async (_config: unknown, _sessionId: string, _signal?: AbortSignal): Promise<void> => {}
  ),
}));

// Everything about the client stays real except the two teardown calls, so the
// gate's ownership is exercised against the real `cleanupRemoteSession` and the
// real shared-scenario registry.
vi.mock('../../e2e/client.js', async importOriginal => {
  const actual = await importOriginal<typeof ClientModule>();
  return {
    ...actual,
    interruptSession: mocks.interruptSession,
    deleteSession: mocks.deleteSession,
  };
});

// `client.js` statically imports `auth.js`, which imports `@kilocode/db`; the
// real client only uses these two exporters, so stubbing them keeps that
// package out of this test's module graph.
vi.mock('../../e2e/auth.js', () => ({
  mintApiToken: vi.fn(() => 'minted-token'),
  mintStreamTicket: vi.fn(() => 'minted-ticket'),
}));

import type { DriverConfig } from '../../e2e/client.js';
import type * as ClientModule from '../../e2e/client.js';
import type { LifecycleArgs, LifecycleResult } from '../../e2e/lifecycle.js';
import { runSharedScenario } from '../../e2e/scenario-capabilities.js';
import type {
  RunnableSharedScenario,
  SandboxObservation,
  ScenarioEnvironment,
} from '../../e2e/scenario-capabilities.js';
import { cleanupRemoteSession } from '../../e2e/scenarios-shared.js';

const config: DriverConfig = {
  workerUrl: 'https://worker.example.test',
  user: { id: 'usr_deployed' },
  bearerToken: 'deployed-token',
  skipBalanceCheck: false,
  gitUrl: 'https://example.test/repo.git',
  model: 'kilo/fake-deterministic',
  fakeLlmUrl: 'https://fake.example.test',
};

function deployedEnv(): ScenarioEnvironment {
  return { profile: 'deployed', requireControlPlaneSession: true };
}

function localEnv(): ScenarioEnvironment {
  const sandbox: SandboxObservation = {
    snapshotContainerIds: vi.fn(async () => new Set<string>()),
    waitForOwnedContainer: vi.fn(async () => null),
    waitForNewContainer: vi.fn(async () => null),
  };
  return { profile: 'local', requireControlPlaneSession: false, sandbox };
}

function passingResult(name: string, conversation: string): LifecycleResult {
  return { name, conversation, ok: true, message: 'ran', events: [], durationMs: 0 };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('gate session teardown', () => {
  it('releases every created session newest first through deleteSession', async () => {
    const definition: RunnableSharedScenario = {
      name: 'teardown-order',
      requires: [],
      run: async (args: LifecycleArgs) => {
        args.config.onSessionCreated?.('workspace_first', 'ses_first');
        args.config.onSessionCreated?.('workspace_second', 'ses_second');
        return passingResult('teardown-order', args.conversation);
      },
    };

    const result = await runSharedScenario(definition, {
      config,
      conversation: '_',
      env: deployedEnv(),
    });

    expect(result.ok).toBe(true);
    // Newest-first is the cleanup contract: the later session is released
    // before the session it was created from. This assertion fails if the gate
    // returns without owning teardown.
    expect(mocks.deleteSession.mock.calls.map(call => call[1])).toEqual([
      'workspace_second',
      'workspace_first',
    ]);
    expect(mocks.interruptSession.mock.calls.map(call => call[1])).toEqual([
      'workspace_second',
      'workspace_first',
    ]);
  });

  it('starts nothing and cleans nothing for an unsupported deployed scenario', async () => {
    const run = vi.fn(async (args: LifecycleArgs) =>
      passingResult('absent-capability', args.conversation)
    );
    const definition: RunnableSharedScenario = {
      name: 'absent-capability',
      requires: ['gates'],
      run,
    };

    const result = await runSharedScenario(definition, {
      config,
      conversation: '_',
      env: deployedEnv(),
    });

    expect(result.ok).toBe(false);
    expect(result.unsupported).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(mocks.interruptSession).not.toHaveBeenCalled();
    expect(mocks.deleteSession).not.toHaveBeenCalled();
  });

  it('releases sessions under the local profile and reclaims their sandboxes afterwards', async () => {
    const reclaimSessions = vi.fn(async () => {});
    const definition: RunnableSharedScenario = {
      name: 'local-teardown',
      requires: ['sandbox'],
      run: async (args: LifecycleArgs) => {
        args.config.onSessionCreated?.('workspace_first', 'ses_first');
        args.config.onSessionCreated?.('workspace_second', 'ses_second');
        return passingResult('local-teardown', args.conversation);
      },
    };

    const result = await runSharedScenario(definition, {
      config,
      conversation: '_',
      env: { ...localEnv(), reclaimSessions },
    });

    expect(result.ok).toBe(true);
    expect(mocks.deleteSession.mock.calls.map(call => call[1])).toEqual([
      'workspace_second',
      'workspace_first',
    ]);
    expect(reclaimSessions).toHaveBeenCalledWith([
      { sessionId: 'workspace_second', kiloSessionId: 'ses_second' },
      { sessionId: 'workspace_first', kiloSessionId: 'ses_first' },
    ]);
    // A container is only stopped once nothing can recreate demand for it.
    const lastDelete = Math.max(...mocks.deleteSession.mock.invocationCallOrder);
    expect(reclaimSessions.mock.invocationCallOrder[0]).toBeGreaterThan(lastDelete);
  });

  it('reclaims even when the scenario throws', async () => {
    const reclaimSessions = vi.fn(async () => {});
    const definition: RunnableSharedScenario = {
      name: 'local-throws',
      requires: ['sandbox'],
      run: async (args: LifecycleArgs) => {
        args.config.onSessionCreated?.('workspace_only', 'ses_only');
        throw new Error('boom');
      },
    };

    await expect(
      runSharedScenario(definition, {
        config,
        conversation: '_',
        env: { ...localEnv(), reclaimSessions },
      })
    ).rejects.toThrow('boom');

    expect(mocks.deleteSession.mock.calls.map(call => call[1])).toEqual(['workspace_only']);
    expect(reclaimSessions).toHaveBeenCalledWith([
      { sessionId: 'workspace_only', kiloSessionId: 'ses_only' },
    ]);
  });

  it('keeps the scenario result when the reclaim hook fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const definition: RunnableSharedScenario = {
      name: 'local-reclaim-fails',
      requires: ['sandbox'],
      run: async (args: LifecycleArgs) => passingResult('local-reclaim-fails', args.conversation),
    };

    const result = await runSharedScenario(definition, {
      config,
      conversation: '_',
      env: {
        ...localEnv(),
        reclaimSessions: vi.fn(async () => {
          throw new Error('docker unavailable');
        }),
      },
    });

    expect(result.ok).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('docker unavailable'));
  });

  it('reclaims nothing for an unsupported scenario', async () => {
    const reclaimSessions = vi.fn(async () => {});
    const definition: RunnableSharedScenario = {
      name: 'unsupported-local',
      requires: ['gates'],
      run: vi.fn(),
    };

    const result = await runSharedScenario(definition, {
      config,
      conversation: '_',
      env: { ...localEnv(), reclaimSessions },
    });

    expect(result.unsupported).toBe(true);
    expect(reclaimSessions).not.toHaveBeenCalled();
    expect(mocks.deleteSession).not.toHaveBeenCalled();
  });
});

describe('cleanupRemoteSession delete budget', () => {
  it('bounds interruptSession at 15s and deleteSession at 45s', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    await cleanupRemoteSession(config, 'workspace_bounded', 'label');

    expect(timeoutSpy.mock.calls.map(call => call[0])).toEqual([15_000, 45_000]);
    // Each bound's own signal reaches the matching call, so the 45s budget is
    // not silently applied to the interrupt (or dropped).
    expect(mocks.interruptSession.mock.calls[0]?.[2]).toBe(timeoutSpy.mock.results[0]?.value);
    expect(mocks.deleteSession.mock.calls[0]?.[2]).toBe(timeoutSpy.mock.results[1]?.value);
  });
});
