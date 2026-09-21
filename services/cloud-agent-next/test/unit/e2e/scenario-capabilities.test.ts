import { describe, expect, it, vi } from 'vitest';

import type { DriverConfig } from '../../e2e/client.js';
import {
  assessScenarioSupport,
  isScenarioSupported,
  missingCapabilities,
  resolveScenarioApi,
  runSharedScenario,
} from '../../e2e/scenario-capabilities.js';
import type {
  CapabilityName,
  RunnableSharedScenario,
  SandboxFaultObservation,
  SandboxObservation,
  ScenarioEnvironment,
  SessionSandboxObservation,
} from '../../e2e/scenario-capabilities.js';
import type { LifecycleArgs, LifecycleResult } from '../../e2e/lifecycle.js';

const config: DriverConfig = {
  workerUrl: 'https://worker.example.test',
  user: { id: 'usr_unit' },
  gitUrl: 'https://example.test/repo.git',
  model: 'kilo/fake-deterministic',
  fakeLlmUrl: 'https://fake.example.test',
};

function args(overrides: Partial<LifecycleArgs> = {}): LifecycleArgs {
  return { config, conversation: 'echo:hi', ...overrides };
}

function sandboxStub(): SandboxObservation {
  return {
    snapshotContainerIds: vi.fn(async () => new Set<string>()),
    waitForOwnedContainer: vi.fn(async () => null),
    waitForNewContainer: vi.fn(async () => null),
  };
}

function localEnv(): ScenarioEnvironment {
  return { profile: 'local', requireControlPlaneSession: false, sandbox: sandboxStub() };
}

function sessionSandboxStub(): SessionSandboxObservation {
  return {
    waitForContainer: vi.fn(async () => null),
    currentContainer: vi.fn(async () => null),
  };
}

function localHttpEnv(): ScenarioEnvironment {
  return {
    profile: 'local-http',
    requireControlPlaneSession: true,
    sessionSandbox: sessionSandboxStub(),
    deployedHttpAuthBoundary: { modelRoutesAuthenticated: true },
  };
}

function passingResult(name: string, conversation: string): LifecycleResult {
  return { name, conversation, ok: true, message: 'ran', events: [], durationMs: 0 };
}

function definition(
  name: string,
  requires: readonly CapabilityName[],
  run: RunnableSharedScenario['run']
): RunnableSharedScenario {
  return { name, requires, run };
}

describe('runSharedScenario gate', () => {
  it('errors without an injected environment before running any side effect', async () => {
    const run = vi.fn(async (a: LifecycleArgs) => passingResult('probe', a.conversation));

    const result = await runSharedScenario(definition('probe', [], run), args());

    expect(result.ok).toBe(false);
    expect(result.unsupported).toBeUndefined();
    expect(result.message).toBe(
      'error: shared scenario "probe" requires an injected ScenarioEnvironment'
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('errors when a local environment is missing the mandatory sandbox capability', async () => {
    const run = vi.fn(async (a: LifecycleArgs) => passingResult('probe', a.conversation));

    const result = await runSharedScenario(
      definition('probe', [], run),
      args({ env: { profile: 'local', requireControlPlaneSession: false } })
    );

    expect(result.ok).toBe(false);
    expect(result.unsupported).toBeUndefined();
    expect(result.message).toBe(
      'error: local profile environment is missing the mandatory "sandbox" capability'
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps sandbox mandatory for the local profile even when sessionSandbox is present', async () => {
    const run = vi.fn(async (a: LifecycleArgs) => passingResult('probe', a.conversation));

    const result = await runSharedScenario(
      definition('probe', [], run),
      args({
        env: {
          profile: 'local',
          requireControlPlaneSession: false,
          sessionSandbox: sessionSandboxStub(),
        },
      })
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('mandatory "sandbox" capability');
    expect(run).not.toHaveBeenCalled();
  });

  it('accepts the local-http profile without a Docker sandbox when sessionSandbox is present', async () => {
    const env = localHttpEnv();
    const run = vi.fn(async (a: LifecycleArgs) => passingResult('probe', a.conversation));

    const result = await runSharedScenario(
      definition('probe', ['sessionSandbox'], run),
      args({ env })
    );

    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('returns unsupported for local-http when sessionSandbox is absent', async () => {
    const run = vi.fn(async (a: LifecycleArgs) => passingResult('probe', a.conversation));

    const result = await runSharedScenario(
      definition('probe', ['sessionSandbox'], run),
      args({
        env: {
          profile: 'local-http',
          requireControlPlaneSession: true,
          deployedHttpAuthBoundary: { modelRoutesAuthenticated: true },
        },
      })
    );

    expect(result.ok).toBe(false);
    expect(result.unsupported).toBe(true);
    expect(result.message).toContain('sessionSandbox');
    expect(run).not.toHaveBeenCalled();
  });

  it('makes sessionSandbox mandatory for local-http even when the definition declares nothing', async () => {
    const run = vi.fn(async (a: LifecycleArgs) => passingResult('probe', a.conversation));

    const result = await runSharedScenario(
      definition('probe', [], run),
      args({
        env: {
          profile: 'local-http',
          requireControlPlaneSession: true,
          deployedHttpAuthBoundary: { modelRoutesAuthenticated: true },
        },
      })
    );

    expect(result.ok).toBe(false);
    expect(result.unsupported).toBe(true);
    expect(result.message).toContain('sessionSandbox');
    expect(run).not.toHaveBeenCalled();
  });

  it('returns unsupported for a declared-but-absent capability', async () => {
    const run = vi.fn(async (a: LifecycleArgs) => passingResult('probe', a.conversation));

    const result = await runSharedScenario(
      definition('probe', ['deployedHttpAuthBoundary'], run),
      args({ env: localEnv() })
    );

    expect(result.ok).toBe(false);
    expect(result.unsupported).toBe(true);
    expect(result.message).toContain('unsupported');
    expect(result.message).toContain('deployedHttpAuthBoundary');
    expect(run).not.toHaveBeenCalled();
  });

  it('runs a scenario whose declared capability is present', async () => {
    const env = localEnv();
    const run = vi.fn(async (a: LifecycleArgs) => passingResult('probe', a.conversation));

    const result = await runSharedScenario(definition('probe', ['sandbox'], run), args({ env }));

    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ env }), env);
  });

  it('runs a scenario that declares no capability under the deployed profile', async () => {
    const run = vi.fn(async (a: LifecycleArgs) => passingResult('probe', a.conversation));

    const result = await runSharedScenario(
      definition('probe', [], run),
      args({
        env: {
          profile: 'deployed',
          requireControlPlaneSession: true,
          deployedHttpAuthBoundary: { modelRoutesAuthenticated: true },
        },
      })
    );

    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('resolveScenarioApi', () => {
  it('pins a definition that declares an API, with or without a matching request', () => {
    expect(
      resolveScenarioApi({ name: 'callback-completion', defaultApi: 'legacy' }, undefined)
    ).toEqual({ ok: true, api: 'legacy' });
    expect(
      resolveScenarioApi({ name: 'callback-completion', defaultApi: 'legacy' }, 'legacy')
    ).toEqual({ ok: true, api: 'legacy' });
  });

  it('rejects a request that conflicts with the pin instead of switching transport', () => {
    const result = resolveScenarioApi(
      { name: 'callback-completion', defaultApi: 'legacy' },
      'unified'
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('requires the legacy API');
      expect(result.message).toContain('--api=unified conflicts with it');
    }
  });

  it('honours an explicit request for an unpinned definition and defaults to unified', () => {
    expect(resolveScenarioApi({ name: 'cold-hot' }, 'legacy')).toEqual({ ok: true, api: 'legacy' });
    expect(resolveScenarioApi({ name: 'cold-hot' }, 'unified')).toEqual({
      ok: true,
      api: 'unified',
    });
    expect(resolveScenarioApi({ name: 'cold-hot' }, undefined)).toEqual({
      ok: true,
      api: 'unified',
    });
  });
});

describe('missingCapabilities', () => {
  it('names every absent declared capability without duplicates', () => {
    expect(
      missingCapabilities(['sandbox', 'deployedHttpAuthBoundary'], {
        profile: 'local',
        requireControlPlaneSession: false,
      })
    ).toEqual(['sandbox', 'deployedHttpAuthBoundary']);
  });

  it('returns an empty list when every declared capability is present', () => {
    expect(
      missingCapabilities(['sandbox', 'deployedHttpAuthBoundary'], {
        profile: 'local',
        requireControlPlaneSession: false,
        sandbox: sandboxStub(),
        deployedHttpAuthBoundary: { modelRoutesAuthenticated: true },
      })
    ).toEqual([]);
  });
});

function sandboxFaultsStub(): SandboxFaultObservation {
  return {
    captureWrapperIdentity: vi.fn(async () => ({ instanceId: 'c:1', pid: 1 })),
    killOwnedContainer: vi.fn(async () => ({ killed: true, observedRef: 'c', detail: '' })),
    freezeWrapperProcess: vi.fn(async () => ({ frozen: true, pid: 1, detail: '' })),
    unfreezeWrapperProcess: vi.fn(async () => {}),
    captureEvidenceCursor: vi.fn(async () => 0),
    observeReapEvidence: vi.fn(async input => ({
      reapedAllocationRef: input.reapedAllocationRef,
      physicalStopCause: 'recovery_settled_reap',
      physicalStopStopCause: 'recovery_settled_reap',
      physicalStopFromState: 'running',
      physicalStopToState: 'stopping',
      providerStopObserved: true,
      heartbeatExpiryDeadline: true,
      recoveryCause: 'heartbeat_expired',
      recoveryOutcome: 'started',
      wrapperReadyAfterFault: false,
      acceptedReconciliation: 'runtime_unhealthy',
      routeStaleActive: true,
    })),
  };
}

describe('assessScenarioSupport', () => {
  it('reports the required set and the missing subset together', () => {
    expect(assessScenarioSupport({ requires: ['gates', 'sandbox'] }, localEnv())).toEqual({
      supported: false,
      required: ['sandbox', 'gates'],
      missing: ['gates'],
    });
  });

  it('reports a supported assessment with no missing capabilities', () => {
    expect(assessScenarioSupport({ requires: ['sandbox'] }, localEnv())).toEqual({
      supported: true,
      required: ['sandbox'],
      missing: [],
    });
  });
});

describe('isScenarioSupported', () => {
  it('is true when the profile-mandatory and declared capabilities are present', () => {
    expect(isScenarioSupported({ requires: ['sandbox'] }, localEnv())).toBe(true);
    expect(isScenarioSupported({ requires: [] }, localHttpEnv())).toBe(true);
    expect(
      isScenarioSupported(
        { requires: ['gates', 'sandboxFaults'] },
        {
          ...localEnv(),
          gates: { parkedStreamsSupported: true },
          sandboxFaults: sandboxFaultsStub(),
        }
      )
    ).toBe(true);
  });

  it('is false when a declared capability is absent', () => {
    expect(isScenarioSupported({ requires: ['gates'] }, localEnv())).toBe(false);
    expect(isScenarioSupported({ requires: ['sandboxFaults'] }, localHttpEnv())).toBe(false);
    expect(isScenarioSupported({ requires: ['callbacks'] }, localEnv())).toBe(false);
  });

  it('is false for a local profile that lacks the mandatory sandbox capability', () => {
    expect(
      isScenarioSupported({ requires: [] }, { profile: 'local', requireControlPlaneSession: false })
    ).toBe(false);
  });

  it('is false for a local-http profile that lacks the mandatory sessionSandbox capability', () => {
    expect(
      isScenarioSupported(
        { requires: [] },
        { profile: 'local-http', requireControlPlaneSession: true }
      )
    ).toBe(false);
  });

  it('is true for the deployed profile with no declared capabilities', () => {
    expect(
      isScenarioSupported(
        { requires: [] },
        { profile: 'deployed', requireControlPlaneSession: true }
      )
    ).toBe(true);
    expect(
      isScenarioSupported(
        { requires: ['sandboxFaults'] },
        { profile: 'deployed', requireControlPlaneSession: true }
      )
    ).toBe(false);
  });
});
