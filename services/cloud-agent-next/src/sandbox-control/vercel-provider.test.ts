import { describe, expect, it, vi } from 'vitest';
import {
  VercelSandboxRestError,
  type VercelSandboxCreateEnvelope,
} from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import type { VercelSandboxRuntimeConfig } from '../agent-sandbox/vercel/vercel-runtime-config.js';
import { parseSandboxBillingInput } from '../container-usage-context.js';
import { DEADLINE_MS } from './deadlines.js';
import { deriveSandboxAllocationId } from '../sandbox-id.js';
import {
  createVercelProviderAdapter,
  decodeVercelProviderRef,
  encodeVercelProviderRef,
  type VercelControlRestClient,
} from './vercel-provider.js';

const config: VercelSandboxRuntimeConfig = {
  accessToken: 'test-token',
  teamId: 'team_1',
  projectId: 'prj_1',
  snapshotId: 'snap_1',
  runtimeBuildId: 'build_1',
  runtime: 'node24',
  initialTimeoutMs: 300_000,
  extendDurationMs: 120_000,
};

const runningSession = {
  id: 'vsess_1',
  sourceSandboxName: 'ses-def',
  projectId: 'prj_1',
  runtime: 'node24',
  status: 'running' as const,
  memory: 2048,
  vcpus: 2,
  region: 'iad1',
  timeout: 300_000,
  requestedAt: 1_000,
  startedAt: 1_000,
  cwd: '/',
  createdAt: 1_000,
  updatedAt: 1_000,
};

const intent = { intentId: 'op_1', createdAt: 1_000, allocationName: 'ses-def' };
const ref = encodeVercelProviderRef({ sandboxName: intent.allocationName, sessionId: 'vsess_1' });

const networkPolicy = {
  mode: 'custom' as const,
  allowedDomains: ['api.kilo.ai', '*'],
  injectionRules: [],
};

function envelope(name = intent.allocationName): VercelSandboxCreateEnvelope {
  return {
    sandbox: {
      name,
      currentSessionId: 'vsess_1',
      status: 'running',
      persistent: false,
      createdAt: 1,
      updatedAt: 1,
      tags: {},
    },
    session: { ...runningSession, sourceSandboxName: name },
    routes: [],
    runtime: { sandboxName: name, sessionId: 'vsess_1' },
  };
}

function fakeClient(overrides: Partial<VercelControlRestClient> = {}): VercelControlRestClient {
  return {
    createSandbox: async input => envelope(input.name),
    inspectByName: async input => envelope(input.name),
    getSession: async () => ({ session: runningSession, routes: [] }),
    executeCommand: async () => ({
      id: 'cmd_1',
      name: 'sh',
      args: ['-lc', 'exec bun run /usr/local/bin/kilocode-control-wrapper.js'],
      cwd: '/',
      sessionId: 'vsess_1',
      exitCode: null,
      startedAt: 1,
    }),
    extendSessionTimeout: async () => runningSession,
    stopSession: async () => ({ ...runningSession, status: 'stopped' as const }),
    readFile: async () => new TextEncoder().encode('wrapper log'),
    updateNetworkPolicy: async () => runningSession,
    ...overrides,
  };
}

describe('vercel provider adapter', () => {
  it('returns the allocated ref before wrapper launch and preserves logical control routing', async () => {
    const executeCommand = vi.fn().mockResolvedValue({});
    const createSandbox = vi.fn(fakeClient().createSandbox);
    const provider = createVercelProviderAdapter({
      sandboxName: intent.allocationName,
      config,
      restClient: fakeClient({ executeCommand, createSandbox }),
    });
    await expect(provider.create(intent)).resolves.toEqual({ providerRef: ref });
    expect(executeCommand).not.toHaveBeenCalled();
    expect(createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ name: intent.allocationName, operationId: intent.intentId })
    );
    await provider.launch(ref, {
      SANDBOX_CONTROL_URL: 'wss://example.test/sandbox-control/ses-abc',
      SANDBOX_CONTROL_CREDENTIAL: 'test-credential',
    });
    expect(executeCommand).toHaveBeenCalledWith('vsess_1', {
      command: 'sh',
      args: ['-lc', 'exec bun run /usr/local/bin/kilocode-control-wrapper.js'],
      cwd: '/',
      wait: false,
      sudo: false,
      env: {
        SANDBOX_CONTROL_URL: 'wss://example.test/sandbox-control/ses-abc',
        SANDBOX_CONTROL_CREDENTIAL: 'test-credential',
        PROVIDER_INSTANCE_ID: ref,
        WRAPPER_LOG_PATH: '/tmp/kilocode-control-wrapper.log',
      },
    });
  });

  it('installs the creation policy before launching the control wrapper', async () => {
    const createSandbox = vi.fn(fakeClient().createSandbox);
    const executeCommand = vi.fn(fakeClient().executeCommand);
    const provider = createVercelProviderAdapter({
      sandboxName: intent.allocationName,
      config,
      restClient: fakeClient({ createSandbox, executeCommand }),
    });

    const created = await provider.create({ ...intent, networkPolicy });
    if (!('providerRef' in created)) throw new Error('Missing allocation');
    expect(executeCommand).not.toHaveBeenCalled();
    expect(createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ name: intent.allocationName, networkPolicy })
    );
    await provider.launch(created.providerRef, {});
    expect(createSandbox.mock.invocationCallOrder[0]).toBeLessThan(
      executeCommand.mock.invocationCallOrder[0]
    );
  });

  it('never launches the wrapper when sandbox creation rejects its policy', async () => {
    const createSandbox = vi.fn().mockRejectedValue(new Error('policy rejected'));
    const executeCommand = vi.fn(fakeClient().executeCommand);
    const provider = createVercelProviderAdapter({
      sandboxName: intent.allocationName,
      config,
      restClient: fakeClient({ createSandbox, executeCommand }),
    });

    await expect(provider.create({ ...intent, networkPolicy })).rejects.toThrow('policy rejected');
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('rejects enforced billing before allocating a Vercel sandbox', async () => {
    const createSandbox = vi.fn();
    const provider = createVercelProviderAdapter({
      sandboxName: intent.allocationName,
      config,
      restClient: fakeClient({ createSandbox }),
    });
    const billing = parseSandboxBillingInput({
      sandboxId: 'ses-abc',
      subject: { type: 'user', id: 'owner_1' },
      actor: { type: 'user', id: 'owner_1' },
      enforcementRequested: true,
    });
    await expect(provider.create({ ...intent, billing })).rejects.toThrow(
      'billing admission is unavailable for Vercel'
    );
    expect(createSandbox).not.toHaveBeenCalled();
  });

  it('creates a fresh named resource after stop even when the provider retains old names', async () => {
    const retainedNames = new Set<string>();
    const createSandbox = vi.fn(
      async (input: Parameters<VercelControlRestClient['createSandbox']>[0]) => {
        if (retainedNames.has(input.name)) throw new Error('name is retained');
        retainedNames.add(input.name);
        return envelope(input.name);
      }
    );
    const first = await deriveSandboxAllocationId('ses-abc', intent.intentId);
    const second = await deriveSandboxAllocationId('ses-abc', 'op_2');
    const original = createVercelProviderAdapter({
      sandboxName: first,
      config,
      restClient: fakeClient({ createSandbox }),
    });
    const created = await original.create({ ...intent, allocationName: first });
    if (!('providerRef' in created)) throw new Error('Missing allocation');
    await expect(original.stop(created.providerRef)).resolves.toBe('terminal');
    const replacement = createVercelProviderAdapter({
      sandboxName: second,
      config,
      restClient: fakeClient({ createSandbox }),
    });
    const recreated = await replacement.create({
      ...intent,
      intentId: 'op_2',
      allocationName: second,
    });
    expect(retainedNames).toEqual(new Set([first, second]));
    expect(recreated).not.toEqual(created);
    expect(first).not.toBe(second);
  });

  it('rediscovers an ambiguous create by its retained name and operation without a second create', async () => {
    const createSandbox = vi.fn().mockRejectedValue(new Error('allocation response lost'));
    const inspectByName = vi.fn(fakeClient().inspectByName);
    const executeCommand = vi.fn();
    const provider = createVercelProviderAdapter({
      sandboxName: intent.allocationName,
      config,
      restClient: fakeClient({ createSandbox, inspectByName, executeCommand }),
    });
    await expect(provider.create(intent)).rejects.toThrow('allocation response lost');
    await expect(provider.observe(null, intent)).resolves.toEqual({
      status: 'active',
      providerRef: ref,
    });
    expect(inspectByName).toHaveBeenCalledWith({
      name: intent.allocationName,
      operationId: intent.intentId,
      runtimeBuildId: config.runtimeBuildId,
      snapshotId: config.snapshotId,
      runtime: config.runtime,
    });
    expect(createSandbox).toHaveBeenCalledTimes(1);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('does not call an early not-found authoritative until the create settling window closes', async () => {
    let now = intent.createdAt;
    const provider = createVercelProviderAdapter({
      sandboxName: intent.allocationName,
      config,
      now: () => now,
      restClient: fakeClient({ inspectByName: async () => null }),
    });
    await expect(provider.observe(null, intent)).resolves.toEqual({ status: 'unknown' });
    now += DEADLINE_MS.createSettle;
    await expect(provider.observe(null, intent)).resolves.toEqual({ status: 'terminal' });
    await expect(provider.observe(null)).resolves.toEqual({ status: 'unknown' });
  });

  it('propagates launch failure after returning the ref', async () => {
    const provider = createVercelProviderAdapter({
      sandboxName: intent.allocationName,
      config,
      restClient: fakeClient({
        executeCommand: async () => {
          throw new Error('launch failed');
        },
      }),
    });
    await expect(provider.create(intent)).resolves.toEqual({ providerRef: ref });
    await expect(provider.launch(ref, {})).rejects.toThrow('launch failed');
    await expect(provider.stop(ref)).resolves.toBe('terminal');
  });

  it('maps a running exact session to active, 404 to terminal, and other failures to unknown', async () => {
    const getSession = vi.fn(fakeClient().getSession);
    const provider = createVercelProviderAdapter({
      sandboxName: intent.allocationName,
      config,
      restClient: fakeClient({ getSession }),
    });
    await expect(provider.observe(ref)).resolves.toEqual({ status: 'active' });
    await expect(provider.observe('not-json')).resolves.toEqual({ status: 'unknown' });
    getSession.mockRejectedValueOnce(
      new VercelSandboxRestError('request_failed', 'get-session', 404)
    );
    await expect(provider.observe(ref)).resolves.toEqual({ status: 'terminal' });
    getSession.mockRejectedValueOnce(new VercelSandboxRestError('request_failed', 'get-session'));
    await expect(provider.observe(ref)).resolves.toEqual({ status: 'unknown' });
  });

  it('stop is terminal on 404 or stopped, retryable on failure or absent identity', async () => {
    const stopSession = vi.fn(fakeClient().stopSession);
    const provider = createVercelProviderAdapter({
      sandboxName: intent.allocationName,
      config,
      restClient: fakeClient({ stopSession }),
    });
    await expect(provider.stop(ref)).resolves.toBe('terminal');
    await expect(provider.stop(null, intent)).resolves.toBe('retryable');
    await expect(provider.stop('not-json')).resolves.toBe('retryable');
    stopSession.mockRejectedValueOnce(
      new VercelSandboxRestError('request_failed', 'stop-session', 404)
    );
    await expect(provider.stop(ref)).resolves.toBe('terminal');
    stopSession.mockRejectedValueOnce(
      new VercelSandboxRestError('request_failed', 'stop-session', 500)
    );
    await expect(provider.stop(ref)).resolves.toBe('retryable');
    expect(stopSession).toHaveBeenCalledTimes(3);
  });

  it('keeps Vercel identity unresolved when runtime configuration is missing', async () => {
    const provider = createVercelProviderAdapter({ sandboxName: intent.allocationName });
    await expect(provider.create(intent)).rejects.toThrow('configuration is unavailable');
    await expect(provider.observe(ref)).resolves.toEqual({ status: 'unknown' });
    await expect(provider.stop(ref)).resolves.toBe('retryable');
  });

  it('extends the lease only when remaining lifetime is below the requested floor', async () => {
    let now = 1_000 + 250_000;
    const extendSessionTimeout = vi.fn(fakeClient().extendSessionTimeout);
    const provider = createVercelProviderAdapter({
      sandboxName: intent.allocationName,
      config,
      now: () => now,
      restClient: fakeClient({ extendSessionTimeout }),
    });
    await provider.ensureLeaseAtLeast(ref, 60_000);
    expect(extendSessionTimeout).toHaveBeenCalledWith('vsess_1', intent.allocationName, 120_000);
    extendSessionTimeout.mockClear();
    now = 1_000 + 10_000;
    await provider.ensureLeaseAtLeast(ref, 60_000);
    expect(extendSessionTimeout).not.toHaveBeenCalled();
  });

  it('reads bounded wrapper logs', async () => {
    const provider = createVercelProviderAdapter({
      sandboxName: intent.allocationName,
      config,
      restClient: fakeClient(),
    });
    await expect(provider.logs(ref)).resolves.toBe('wrapper log');
  });

  it('does not inspect, extend, or read sessions from another logical sandbox', async () => {
    const getSession = vi.fn(fakeClient().getSession);
    const extendSessionTimeout = vi.fn(fakeClient().extendSessionTimeout);
    const readFile = vi.fn(fakeClient().readFile);
    const stopSession = vi.fn(fakeClient().stopSession);
    const provider = createVercelProviderAdapter({
      sandboxName: intent.allocationName,
      config,
      restClient: fakeClient({ getSession, extendSessionTimeout, readFile, stopSession }),
    });
    const otherRef = encodeVercelProviderRef({
      sandboxName: 'ses-other',
      sessionId: 'vsess_other',
    });

    await expect(provider.observe(otherRef)).resolves.toEqual({ status: 'unknown' });
    await expect(provider.stop(otherRef)).resolves.toBe('retryable');
    await provider.ensureLeaseAtLeast(otherRef, 60_000);
    await provider.logs(otherRef);

    expect(getSession).not.toHaveBeenCalled();
    expect(stopSession).not.toHaveBeenCalled();
    expect(extendSessionTimeout).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('updates the firewall policy for the exact owned running session', async () => {
    const updateNetworkPolicy = vi.fn(fakeClient().updateNetworkPolicy);
    const provider = createVercelProviderAdapter({
      sandboxName: intent.allocationName,
      config,
      restClient: fakeClient({ updateNetworkPolicy }),
    });
    const ownedRef = encodeVercelProviderRef({
      sandboxName: intent.allocationName,
      sessionId: 'vsess_1',
    });

    await expect(provider.updateNetworkPolicy?.(ownedRef, networkPolicy)).resolves.toBeUndefined();

    expect(updateNetworkPolicy).toHaveBeenCalledWith(
      'vsess_1',
      intent.allocationName,
      networkPolicy
    );
  });

  it.each([
    { description: 'null', ref: null },
    { description: 'malformed', ref: 'not-json' },
    { description: 'logical-only', ref: 'ses-abc' },
    {
      description: 'cross-sandbox',
      ref: encodeVercelProviderRef({ sandboxName: 'ses-other', sessionId: 'vsess_1' }),
    },
  ])('rejects $description provider refs without sending a policy update', async ({ ref }) => {
    const updateNetworkPolicy = vi.fn(fakeClient().updateNetworkPolicy);
    const provider = createVercelProviderAdapter({
      sandboxName: intent.allocationName,
      config,
      restClient: fakeClient({ updateNetworkPolicy }),
    });

    await expect(provider.updateNetworkPolicy?.(ref as string, networkPolicy)).rejects.toThrow(
      'Invalid Vercel sandbox provider reference'
    );
    expect(updateNetworkPolicy).not.toHaveBeenCalled();
  });

  it('rejects a stale session without substituting the latest physical session', async () => {
    const updateNetworkPolicy = vi.fn(fakeClient().updateNetworkPolicy);
    const provider = createVercelProviderAdapter({
      sandboxName: intent.allocationName,
      config,
      restClient: fakeClient({ updateNetworkPolicy }),
    });
    const staleRef = encodeVercelProviderRef({
      sandboxName: intent.allocationName,
      sessionId: 'vsess_old',
    });

    await expect(provider.updateNetworkPolicy?.(staleRef, networkPolicy)).rejects.toThrow(
      'Vercel sandbox policy update returned a different session'
    );
    expect(updateNetworkPolicy).toHaveBeenCalledWith(
      'vsess_old',
      intent.allocationName,
      networkPolicy
    );
  });

  it('rejects a policy update response for another logical sandbox', async () => {
    const updateNetworkPolicy = vi.fn().mockResolvedValue({
      ...runningSession,
      sourceSandboxName: 'ses-other',
    });
    const provider = createVercelProviderAdapter({
      sandboxName: intent.allocationName,
      config,
      restClient: fakeClient({ updateNetworkPolicy }),
    });
    const ownedRef = encodeVercelProviderRef({
      sandboxName: intent.allocationName,
      sessionId: 'vsess_1',
    });

    await expect(provider.updateNetworkPolicy?.(ownedRef, networkPolicy)).rejects.toThrow(
      'Vercel sandbox policy update returned a different session'
    );
  });

  it.each(['pending', 'stopped', 'failed'] as const)(
    'rejects a policy update when the session is %s',
    async status => {
      const updateNetworkPolicy = vi.fn().mockResolvedValue({ ...runningSession, status });
      const provider = createVercelProviderAdapter({
        sandboxName: intent.allocationName,
        config,
        restClient: fakeClient({ updateNetworkPolicy }),
      });
      const ownedRef = encodeVercelProviderRef({
        sandboxName: intent.allocationName,
        sessionId: 'vsess_1',
      });

      await expect(provider.updateNetworkPolicy?.(ownedRef, networkPolicy)).rejects.toThrow(
        'Vercel sandbox session is not running'
      );
    }
  );

  it('round-trips the opaque provider ref', () => {
    expect(decodeVercelProviderRef(ref)).toEqual({
      sandboxName: intent.allocationName,
      sessionId: 'vsess_1',
    });
    expect(decodeVercelProviderRef(null)).toBeNull();
    expect(decodeVercelProviderRef('{"sandboxName":1}')).toBeNull();
  });
});
