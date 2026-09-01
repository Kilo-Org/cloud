import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTimeout } from '@kilocode/worker-utils';
import {
  forceDestroyControlPlaneSandbox,
  parseSandboxBillingInput,
  type MeteredSandboxInstance,
} from '../container-usage-context.js';
import { cleanWorktreeRuntime } from './worktree-deletion.js';
import {
  createCloudflareProviderAdapter,
  decodeCloudflareProviderRef,
  encodeCloudflareProviderRef,
  type CloudflareSandboxHandle,
} from './cloudflare-provider.js';
import { DEADLINE_MS } from './deadlines.js';
import {
  beginStop,
  confirmStopped,
  getWorktreeCredentialContainment,
  recordStopAttempt,
  WORKTREE_CREDENTIAL_CONTAINMENT,
  type PhysicalRecord,
} from './physical-lifecycle.js';
import { deriveSandboxAllocationId } from '../sandbox-id.js';

const PROVIDER_REF = encodeCloudflareProviderRef({
  sandboxId: 'sbx_1',
  containment: true,
  instanceId: 'op_1',
});

function fakeSandbox(overrides: Partial<MeteredSandboxInstance> = {}): CloudflareSandboxHandle {
  return {
    renewActivityTimeout: () => undefined,
    destroy: async () => undefined,
    isContainerRunning: async () => true,
    setOutboundHandler: async () => undefined,
    startProcess: async () => ({ id: 'proc_1' }),
    configureBilling: async () => undefined,
    isBillingBlocked: async () => false,
    ensureBillingAdmission: async () => ({ success: true }),
    ...overrides,
  } as unknown as CloudflareSandboxHandle;
}

const logicalId = 'ses-abcdef';
const intent = {
  intentId: 'op_1',
  createdAt: 1_000,
  allocationName: 'ses-123abc',
  containment: WORKTREE_CREDENTIAL_CONTAINMENT,
};
const billing = parseSandboxBillingInput({
  sandboxId: logicalId,
  subject: { type: 'user', id: 'owner_1' },
  actor: { type: 'user', id: 'owner_1' },
  sessionId: 'workspace_1',
  metadata: { origin: 'cloud-agent' },
  enforcementRequested: true,
});

afterEach(() => vi.useRealTimers());

describe('cloudflare provider adapter', () => {
  it.each([true, false, undefined])(
    'uses persisted containment %s for billing and launch regardless of launch environment',
    async enabled => {
      const setOutboundHandler = vi.fn().mockResolvedValue(undefined);
      const startProcess = vi.fn().mockResolvedValue({ id: 'proc_1' });
      const ensureBillingAdmission = vi.fn().mockResolvedValue({ success: true });
      const getSandbox = vi.fn(() =>
        fakeSandbox({ setOutboundHandler, startProcess, ensureBillingAdmission })
      );
      const provider = createCloudflareProviderAdapter({
        sandboxId: intent.allocationName,
        getSandbox,
        destroy: async () => undefined,
      });
      const created = await provider.create({
        ...intent,
        containment: enabled === undefined ? undefined : getWorktreeCredentialContainment(enabled),
        billing,
      });
      if (!('providerRef' in created)) throw new Error('Missing allocation');
      expect(decodeCloudflareProviderRef(created.providerRef)).toEqual({
        sandboxId: intent.allocationName,
        containment: enabled ?? true,
        instanceId: intent.intentId,
      });
      await provider.launch(created.providerRef, {
        CREDENTIAL_CONTAINMENT_ENABLED: enabled === false ? 'true' : 'false',
      });
      expect(getSandbox).toHaveBeenCalledTimes(2);
      for (const call of getSandbox.mock.calls) {
        expect(call).toEqual([intent.allocationName, { containment: enabled ?? true }]);
      }
      expect(ensureBillingAdmission).toHaveBeenCalledOnce();
      expect(setOutboundHandler).toHaveBeenCalledTimes(enabled === false ? 0 : 1);
      expect(startProcess).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          env: expect.objectContaining({ PROVIDER_INSTANCE_ID: created.providerRef }),
        })
      );
    }
  );

  it.each([true, false])('reconstructs a fenced %s worktree ref for cleanup', async enabled => {
    const getSandbox = vi.fn(() => fakeSandbox());
    const destroy = vi.fn(async () => undefined);
    const provider = createCloudflareProviderAdapter({
      sandboxId: intent.allocationName,
      getSandbox,
      destroy,
    });
    const retainedIntent = { ...intent, containment: getWorktreeCredentialContainment(enabled) };
    const providerRef = encodeCloudflareProviderRef({
      sandboxId: intent.allocationName,
      containment: enabled,
      instanceId: intent.intentId,
    });
    await expect(provider.observe(null, retainedIntent)).resolves.toEqual({
      status: 'active',
      providerRef,
    });
    await expect(provider.stop(null, retainedIntent)).resolves.toBe('terminal');
    expect(getSandbox).toHaveBeenCalledExactlyOnceWith(intent.allocationName, {
      containment: enabled,
    });
    expect(destroy).toHaveBeenCalledExactlyOnceWith(intent.allocationName, {
      containment: enabled,
    });
  });

  it.each([true, false])(
    'cleans the exact physical allocation only after confirmed stop: %s',
    async confirmed => {
      const providerRef = encodeCloudflareProviderRef({
        sandboxId: intent.allocationName,
        containment: true,
        instanceId: intent.intentId,
      });
      let physical: PhysicalRecord = {
        state: 'running',
        providerRef,
        createIntent: intent,
        stopTombstone: null,
        resumable: false,
        containment: { ...WORKTREE_CREDENTIAL_CONTAINMENT, providerRef },
      };
      const values = new Map<string, unknown>([['physical_record', physical]]);
      const storage = {
        get: async (key: string) => values.get(key),
        put: async (key: string, value: unknown) => {
          values.set(key, value);
        },
      };
      const destroy = vi.fn(async () => {
        if (!confirmed) throw new Error('Native stop unavailable');
      });
      const getSandbox = vi.fn(() => fakeSandbox());
      const provider = createCloudflareProviderAdapter({
        sandboxId: intent.allocationName,
        destroy,
        getSandbox,
      });
      const create = vi.spyOn(provider, 'create');
      const launch = vi.spyOn(provider, 'launch');
      const stopRuntime = vi.fn(async () => {
        physical = recordStopAttempt(beginStop(physical, 'worktree_deleted', 2_000));
        await storage.put('physical_record', physical);
        const result = await provider.stop(physical.providerRef, physical.createIntent);
        if (result === 'terminal') physical = confirmStopped(physical);
        await storage.put('physical_record', physical);
        return physical;
      });
      const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
      const cleanup = cleanWorktreeRuntime({
        request: {
          worktreeId,
          kiloUserId: 'oauth/test',
          location: { sandboxId: logicalId, provider: 'cloudflare' },
          sessionIds: ['ses_00000000000000000000000001'],
        },
        directory: `/workspace/owner/worktrees/${worktreeId}`,
        storage: storage as never,
        getProvider: async () => provider,
        stopRuntime,
        exclusive: true,
        hasConnection: () => false,
        sendRequest: async () => {
          throw new Error('No wrapper call expected');
        },
      });
      if (confirmed) {
        await expect(cleanup).resolves.toMatchObject({ destroyed: true, resourcesCleaned: true });
        expect(physical.state).toBe('stopped');
      } else {
        await expect(cleanup).rejects.toThrow('Worktree provider stop is unconfirmed');
        expect(physical).toMatchObject({
          state: 'stopping',
          providerRef,
          stopTombstone: { attempts: 1, createdAt: 2_000 },
        });
        expect(values.get(`worktree_deletion/${worktreeId}`)).toMatchObject({
          destroyed: false,
          resourcesCleaned: false,
          completed: false,
        });
      }
      expect(stopRuntime).toHaveBeenCalledOnce();
      expect(destroy).toHaveBeenCalledExactlyOnceWith(intent.allocationName, { containment: true });
      expect(getSandbox).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
    }
  );

  it('returns the physical identity without waking, then launches against that identity', async () => {
    const startProcess = vi.fn().mockResolvedValue({ id: 'proc_1' });
    const setOutboundHandler = vi.fn().mockResolvedValue(undefined);
    const getSandbox = vi.fn(() => fakeSandbox({ startProcess, setOutboundHandler }));
    const provider = createCloudflareProviderAdapter({
      sandboxId: intent.allocationName,
      getSandbox,
      destroy: async () => undefined,
    });
    const providerRef = encodeCloudflareProviderRef({
      sandboxId: intent.allocationName,
      containment: true,
      instanceId: intent.intentId,
    });
    const created = await provider.create(intent);
    expect(created).toEqual({ providerRef });
    expect(getSandbox).not.toHaveBeenCalled();
    expect(startProcess).not.toHaveBeenCalled();

    await provider.launch(providerRef, {
      SANDBOX_CONTROL_URL: `wss://example.test/sandbox-control/${logicalId}`,
      SANDBOX_CONTROL_CREDENTIAL: 'test-credential',
    });
    expect(getSandbox).toHaveBeenCalledWith(intent.allocationName, { containment: true });
    expect(setOutboundHandler).toHaveBeenCalledWith('managedScm');
    expect(startProcess).toHaveBeenCalledWith(
      'bun run /usr/local/bin/kilocode-control-wrapper.js',
      {
        cwd: '/',
        env: {
          SANDBOX_CONTROL_URL: `wss://example.test/sandbox-control/${logicalId}`,
          SANDBOX_CONTROL_CREDENTIAL: 'test-credential',
          PROVIDER_INSTANCE_ID: providerRef,
          WRAPPER_LOG_PATH: '/tmp/kilocode-control-wrapper.log',
        },
      }
    );
  });

  it('denies enforced billing before any compute is started', async () => {
    const startProcess = vi.fn();
    const ensureBillingAdmission = vi.fn().mockResolvedValue({
      success: false,
      code: 'insufficient_credits',
      message: 'not enough credits',
    });
    const provider = createCloudflareProviderAdapter({
      sandboxId: intent.allocationName,
      destroy: async () => undefined,
      getSandbox: () => fakeSandbox({ startProcess, ensureBillingAdmission }),
    });
    await expect(provider.create({ ...intent, billing })).rejects.toThrow('additional credits');
    expect(ensureBillingAdmission).toHaveBeenCalledWith({
      ...billing,
      sandboxId: intent.allocationName,
    });
    expect(startProcess).not.toHaveBeenCalled();
  });

  it('fails closed when the enforced admission capability is absent', async () => {
    const startProcess = vi.fn();
    const sandbox = fakeSandbox({ startProcess });
    Reflect.deleteProperty(sandbox, 'ensureBillingAdmission');
    const provider = createCloudflareProviderAdapter({
      sandboxId: intent.allocationName,
      destroy: async () => undefined,
      getSandbox: () => sandbox,
    });
    await expect(provider.create({ ...intent, billing })).rejects.toThrow(
      'temporarily unavailable'
    );
    expect(startProcess).not.toHaveBeenCalled();
  });

  it('configures shadow attribution on the physical allocation before launch', async () => {
    const actions: string[] = [];
    const configureBilling = vi.fn(async () => {
      actions.push('attributed');
    });
    const sandbox = fakeSandbox({
      configureBilling,
      startProcess: vi.fn().mockImplementation(async () => {
        actions.push('started');
        return { id: 'proc_1' };
      }),
    });
    const provider = createCloudflareProviderAdapter({
      sandboxId: intent.allocationName,
      destroy: async () => undefined,
      getSandbox: () => sandbox,
    });
    const created = await provider.create({
      ...intent,
      billing: { ...billing, enforcementRequested: false },
    });
    if (!('providerRef' in created)) throw new Error('Missing allocation');
    expect(actions).toEqual(['attributed']);
    await provider.launch(created.providerRef, {});
    expect(actions).toEqual(['attributed', 'started']);
    expect(configureBilling).toHaveBeenCalledWith({
      ...billing,
      enforcementRequested: false,
      sandboxId: intent.allocationName,
    });
  });

  it('awaits native outbound interception before exposing the wrapper control environment', async () => {
    const installed = Promise.withResolvers<void>();
    const actions: string[] = [];
    const startProcess = vi.fn().mockImplementation(async () => {
      actions.push('started');
      return { id: 'proc_1' };
    });
    const provider = createCloudflareProviderAdapter({
      sandboxId: 'sbx_1',
      destroy: async () => undefined,
      getSandbox: () =>
        fakeSandbox({
          startProcess,
          setOutboundHandler: vi.fn(async () => {
            actions.push('installing');
            await installed.promise;
            actions.push('installed');
          }),
        }),
    });
    const launching = provider.launch(PROVIDER_REF, { PROVIDER_INSTANCE_ID: 'guest-supplied' });
    expect(actions).toEqual(['installing']);
    expect(startProcess).not.toHaveBeenCalled();
    installed.resolve();
    await launching;
    expect(actions).toEqual(['installing', 'installed', 'started']);
    expect(startProcess).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        env: expect.objectContaining({ PROVIDER_INSTANCE_ID: PROVIDER_REF }),
      })
    );
  });

  it.each(['setOutboundHandler', 'startProcess'] as const)(
    'retains the exact contained allocation for native cleanup when %s fails',
    async method => {
      const startProcess = vi.fn().mockResolvedValue({ id: 'proc_1' });
      const setOutboundHandler = vi.fn().mockResolvedValue(undefined);
      const destroy = vi.fn(async () => undefined);
      const getSandbox = vi.fn(() =>
        fakeSandbox({
          startProcess,
          setOutboundHandler,
          [method]: vi.fn().mockRejectedValue(new Error('startup failed')),
        })
      );
      const provider = createCloudflareProviderAdapter({ sandboxId: 'sbx_1', getSandbox, destroy });
      await expect(
        provider.create({
          intentId: 'op_1',
          createdAt: 1000,
          containment: WORKTREE_CREDENTIAL_CONTAINMENT,
        })
      ).resolves.toEqual({ providerRef: PROVIDER_REF });
      await expect(provider.launch(PROVIDER_REF, {})).rejects.toThrow('startup failed');
      if (method === 'setOutboundHandler') expect(startProcess).not.toHaveBeenCalled();
      await expect(provider.stop(PROVIDER_REF)).resolves.toBe('terminal');
      expect(getSandbox).toHaveBeenCalledExactlyOnceWith('sbx_1', { containment: true });
      expect(destroy).toHaveBeenCalledExactlyOnceWith('sbx_1', { containment: true });
    }
  );

  it.each([
    { ref: PROVIDER_REF, containment: true },
    {
      ref: encodeCloudflareProviderRef({
        sandboxId: 'sbx_1',
        containment: false,
        instanceId: 'op_1',
      }),
      containment: false,
    },
    { ref: 'sbx_1', containment: false },
  ])(
    'observes, renews, and destroys only the encoded namespace without waking',
    async ({ ref, containment }) => {
      const isContainerRunning = vi.fn().mockResolvedValue(true);
      const startProcess = vi.fn();
      const setOutboundHandler = vi.fn();
      const renewActivityTimeout = vi.fn();
      const sdkDestroy = vi.fn();
      const destroy = vi.fn(async () => undefined);
      const getSandbox = vi.fn(() =>
        fakeSandbox({
          isContainerRunning,
          startProcess,
          setOutboundHandler,
          renewActivityTimeout,
          destroy: sdkDestroy,
        })
      );
      const provider = createCloudflareProviderAdapter({ sandboxId: 'sbx_1', getSandbox, destroy });
      await expect(provider.observe(ref)).resolves.toEqual({ status: 'active', providerRef: ref });
      isContainerRunning.mockResolvedValue(false);
      await expect(provider.observe(ref)).resolves.toEqual({
        status: 'terminal',
        providerRef: ref,
      });
      isContainerRunning.mockRejectedValue(new Error('inspection failed'));
      await expect(provider.observe(ref)).resolves.toEqual({ status: 'unknown', providerRef: ref });
      await provider.ensureLeaseAtLeast(ref, 360_000);
      await expect(provider.stop(ref)).resolves.toBe('terminal');
      expect(getSandbox).toHaveBeenCalledWith('sbx_1', { containment });
      expect(destroy).toHaveBeenCalledWith('sbx_1', { containment });
      expect(renewActivityTimeout).toHaveBeenCalledOnce();
      expect(startProcess).not.toHaveBeenCalled();
      expect(setOutboundHandler).not.toHaveBeenCalled();
      expect(sdkDestroy).not.toHaveBeenCalled();
    }
  );

  it('keeps missing native destruction retryable without using SDK cleanup', async () => {
    const sdkDestroy = vi.fn(async () => undefined);
    const sandbox = fakeSandbox({ destroy: sdkDestroy });
    const getSandbox = vi.fn(() => sandbox);
    const provider = createCloudflareProviderAdapter({
      sandboxId: 'sbx_1',
      getSandbox,
      destroy: () => forceDestroyControlPlaneSandbox(sandbox),
    });
    await expect(provider.stop(PROVIDER_REF)).resolves.toBe('retryable');
    expect(sdkDestroy).not.toHaveBeenCalled();
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it('uses distinct class-compatible native allocations after confirmed cleanup', async () => {
    const first = await deriveSandboxAllocationId(logicalId, 'first');
    const second = await deriveSandboxAllocationId(logicalId, 'second');
    const names: string[] = [];
    const destroy = vi.fn(async () => undefined);
    for (const [name, intentId] of [
      [first, 'first'],
      [second, 'second'],
    ]) {
      const provider = createCloudflareProviderAdapter({
        sandboxId: name,
        destroy,
        getSandbox: id => {
          names.push(id);
          return fakeSandbox();
        },
      });
      const created = await provider.create({ ...intent, allocationName: name, intentId });
      if (!('providerRef' in created)) throw new Error('Missing allocation');
      expect(decodeCloudflareProviderRef(created.providerRef)).toEqual({
        sandboxId: name,
        containment: true,
        instanceId: intentId,
      });
      await provider.launch(created.providerRef, {});
      if (name === first)
        await expect(provider.stop(created.providerRef)).resolves.toBe('terminal');
    }
    expect(names).toEqual([first, second]);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^ses-[a-f0-9]{48}$/);
    expect(second).toMatch(/^ses-[a-f0-9]{48}$/);
    expect(destroy).toHaveBeenCalledExactlyOnceWith(first, { containment: true });
  });

  it('uses the creation intent as the instance fence for each replacement', async () => {
    const getSandbox = vi.fn(() => fakeSandbox());
    const provider = createCloudflareProviderAdapter({
      sandboxId: 'sbx_1',
      getSandbox,
      destroy: async () => undefined,
    });
    const first = await provider.create({ intentId: 'op_1', createdAt: 1_000 });
    const second = await provider.create({ intentId: 'op_2', createdAt: 1_000 });

    expect(first).toEqual({ providerRef: PROVIDER_REF });
    expect(second).toEqual({
      providerRef: encodeCloudflareProviderRef({
        sandboxId: 'sbx_1',
        containment: true,
        instanceId: 'op_2',
      }),
    });
    expect(first).not.toEqual(second);
  });

  it('observes a missing ref by its retained intent without waking, and preserves settling uncertainty', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(intent.createdAt);
    let running = true;
    const startProcess = vi.fn();
    const getSandbox = vi.fn(() =>
      fakeSandbox({
        startProcess,
        isContainerRunning: async () => running,
      })
    );
    const provider = createCloudflareProviderAdapter({
      sandboxId: intent.allocationName,
      getSandbox,
      destroy: async () => undefined,
    });
    const expectedRef = encodeCloudflareProviderRef({
      sandboxId: intent.allocationName,
      containment: true,
      instanceId: intent.intentId,
    });
    await expect(provider.observe(null, intent)).resolves.toEqual({
      status: 'active',
      providerRef: expectedRef,
    });
    running = false;
    await expect(provider.observe(null, intent)).resolves.toEqual({
      status: 'unknown',
      providerRef: expectedRef,
    });
    vi.setSystemTime(intent.createdAt + DEADLINE_MS.createSettle);
    await expect(provider.observe(null, intent)).resolves.toEqual({
      status: 'terminal',
      providerRef: expectedRef,
    });
    await expect(provider.observe(null)).resolves.toEqual({ status: 'unknown' });
    expect(getSandbox).toHaveBeenCalledWith(intent.allocationName, { containment: true });
    expect(startProcess).not.toHaveBeenCalled();
  });

  it('keeps historical null-reference cleanup in its original uncontained namespace', async () => {
    const getSandbox = vi.fn(() => fakeSandbox());
    const destroy = vi.fn(async () => undefined);
    const provider = createCloudflareProviderAdapter({ sandboxId: logicalId, getSandbox, destroy });
    const legacyIntent = { intentId: 'legacy', createdAt: 1000 };
    await expect(provider.observe(null, legacyIntent)).resolves.toEqual({
      status: 'active',
      providerRef: logicalId,
    });
    await expect(provider.stop(null, legacyIntent)).resolves.toBe('terminal');
    expect(getSandbox).toHaveBeenCalledExactlyOnceWith(logicalId, { containment: false });
    expect(destroy).toHaveBeenCalledExactlyOnceWith(logicalId, { containment: false });
  });

  it('keeps unavailable or failed native lookups unknown', async () => {
    const getSandbox = vi.fn(() => fakeSandbox({ isContainerRunning: undefined }));
    const provider = createCloudflareProviderAdapter({
      sandboxId: 'sbx_1',
      getSandbox,
      destroy: async () => undefined,
    });
    await expect(provider.observe(PROVIDER_REF)).resolves.toEqual({
      status: 'unknown',
      providerRef: PROVIDER_REF,
    });
    getSandbox.mockImplementation(() => {
      throw new Error('lookup failed');
    });
    await expect(provider.observe(PROVIDER_REF)).resolves.toEqual({
      status: 'unknown',
      providerRef: PROVIDER_REF,
    });
  });

  it('keeps failed observations unknown rather than treating them as physical death', async () => {
    const providerRef = encodeCloudflareProviderRef({
      sandboxId: intent.allocationName,
      containment: true,
      instanceId: intent.intentId,
    });
    const provider = createCloudflareProviderAdapter({
      sandboxId: intent.allocationName,
      destroy: async () => undefined,
      getSandbox: () =>
        fakeSandbox({
          isContainerRunning: async () => {
            throw new Error('offline');
          },
        }),
    });
    await expect(provider.observe(providerRef)).resolves.toEqual({
      status: 'unknown',
      providerRef,
    });
  });

  it('keeps a failed stop retryable and can later observe physical death without another start', async () => {
    let running = true;
    const startProcess = vi.fn();
    const destroy = vi.fn().mockRejectedValue(new Error('provider unavailable'));
    const providerRef = encodeCloudflareProviderRef({
      sandboxId: intent.allocationName,
      containment: true,
      instanceId: intent.intentId,
    });
    const provider = createCloudflareProviderAdapter({
      sandboxId: intent.allocationName,
      destroy,
      getSandbox: () => fakeSandbox({ startProcess, isContainerRunning: async () => running }),
    });
    await expect(provider.stop(providerRef)).resolves.toBe('retryable');
    await expect(provider.observe(providerRef)).resolves.toEqual({
      status: 'active',
      providerRef,
    });
    running = false;
    await expect(provider.observe(providerRef)).resolves.toEqual({
      status: 'terminal',
      providerRef,
    });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(startProcess).not.toHaveBeenCalled();
  });

  it('destroys allocation through a raw namespace stub without SDK acquisition', async () => {
    const providerRef = encodeCloudflareProviderRef({
      sandboxId: intent.allocationName,
      containment: true,
      instanceId: intent.intentId,
    });
    const runtime = {
      running: true,
      async forceDestroyForControlPlane() {
        this.running = false;
      },
    };
    const namespace = { getByName: vi.fn((_id: string) => runtime) };
    const getSandbox = vi.fn(() => {
      throw new Error('SDK acquisition must not run during physical destruction');
    });
    const provider = createCloudflareProviderAdapter({
      sandboxId: intent.allocationName,
      getSandbox,
      destroy: (id, _opts) => forceDestroyControlPlaneSandbox(namespace.getByName(id)),
    });

    await expect(provider.stop(providerRef)).resolves.toBe('terminal');

    expect(runtime.running).toBe(false);
    expect(namespace.getByName).toHaveBeenCalledExactlyOnceWith(intent.allocationName);
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it('does not destroy anything without a retained allocation identity', async () => {
    const destroy = vi.fn(async () => undefined);
    const getSandbox = vi.fn(() => fakeSandbox());
    const provider = createCloudflareProviderAdapter({ sandboxId: logicalId, getSandbox, destroy });

    await expect(provider.stop(null)).resolves.toBe('retryable');

    expect(destroy).not.toHaveBeenCalled();
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it('does not interpret a lost native stop acknowledgement as terminal success', async () => {
    let running = true;
    const startProcess = vi.fn();
    const providerRef = encodeCloudflareProviderRef({
      sandboxId: intent.allocationName,
      containment: true,
      instanceId: intent.intentId,
    });
    const destroy = vi.fn(async () => {
      running = false;
      throw new Error('Native destroy acknowledgement lost');
    });
    const provider = createCloudflareProviderAdapter({
      sandboxId: intent.allocationName,
      destroy,
      getSandbox: () => fakeSandbox({ startProcess, isContainerRunning: async () => running }),
    });

    await expect(provider.stop(providerRef)).resolves.toBe('retryable');
    await expect(provider.observe(providerRef)).resolves.toEqual({
      status: 'terminal',
      providerRef,
    });

    expect(destroy).toHaveBeenCalledExactlyOnceWith(intent.allocationName, { containment: true });
    expect(startProcess).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'leaves a hanging native stop unresolved until acknowledgement, physical running: %s',
    async runningAfterIssuance => {
      vi.useFakeTimers();
      let running = true;
      const providerRef = encodeCloudflareProviderRef({
        sandboxId: intent.allocationName,
        containment: true,
        instanceId: intent.intentId,
      });
      const acknowledgement = Promise.withResolvers<void>();
      const destroy = vi.fn(async () => {
        running = runningAfterIssuance;
        await acknowledgement.promise;
        running = false;
      });
      const getSandbox = vi.fn(() => fakeSandbox({ isContainerRunning: async () => running }));
      const provider = createCloudflareProviderAdapter({
        sandboxId: intent.allocationName,
        getSandbox,
        destroy,
      });
      const settled = vi.fn();
      const stopping = provider.stop(providerRef).then(settled);
      const timedOut = expect(
        withTimeout(stopping, DEADLINE_MS.stopAttempt, 'Native destroy acknowledgement timed out')
      ).rejects.toThrow('Native destroy acknowledgement timed out');

      await vi.advanceTimersByTimeAsync(DEADLINE_MS.stopAttempt);
      await timedOut;

      expect(settled).not.toHaveBeenCalled();
      expect(destroy).toHaveBeenCalledExactlyOnceWith(intent.allocationName, { containment: true });
      expect(getSandbox).not.toHaveBeenCalled();
      await expect(provider.observe(providerRef)).resolves.toEqual({
        status: runningAfterIssuance ? 'active' : 'terminal',
        providerRef,
      });
      acknowledgement.resolve();
      await stopping;
      expect(settled).toHaveBeenCalledExactlyOnceWith('terminal');
    }
  );

  it('propagates launch failure without losing the known allocation', async () => {
    const providerRef = encodeCloudflareProviderRef({
      sandboxId: intent.allocationName,
      containment: true,
      instanceId: intent.intentId,
    });
    const provider = createCloudflareProviderAdapter({
      sandboxId: intent.allocationName,
      destroy: async () => undefined,
      getSandbox: () =>
        fakeSandbox({ startProcess: vi.fn().mockRejectedValue(new Error('launch failed')) }),
    });
    await expect(provider.create(intent)).resolves.toEqual({ providerRef });
    await expect(provider.launch(providerRef, {})).rejects.toThrow('launch failed');
    await expect(provider.observe(providerRef)).resolves.toEqual({
      status: 'active',
      providerRef,
    });
  });

  it('renews the lease on the physical ref', async () => {
    const providerRef = encodeCloudflareProviderRef({
      sandboxId: intent.allocationName,
      containment: true,
      instanceId: intent.intentId,
    });
    const renewed: string[] = [];
    const provider = createCloudflareProviderAdapter({
      sandboxId: intent.allocationName,
      destroy: async () => undefined,
      getSandbox: (id, _opts) =>
        fakeSandbox({
          renewActivityTimeout: () => {
            renewed.push(id);
          },
        }),
    });
    await provider.ensureLeaseAtLeast(providerRef, 360_000);
    expect(renewed).toEqual([intent.allocationName]);
  });

  it.each([
    '',
    'not-json',
    'sbx_other',
    JSON.stringify({ sandboxId: 'sbx_1', containment: true }),
    JSON.stringify({ sandboxId: 'sbx_1', containment: 'false', instanceId: 'op_1' }),
    encodeCloudflareProviderRef({
      sandboxId: 'sbx_other',
      containment: true,
      instanceId: 'op_1',
    }),
  ])('never looks up a sandbox for malformed or cross-sandbox refs', async ref => {
    const getSandbox = vi.fn(() => fakeSandbox());
    const provider = createCloudflareProviderAdapter({
      sandboxId: 'sbx_1',
      getSandbox,
      destroy: async () => undefined,
    });

    await expect(provider.observe(ref)).resolves.toEqual({ status: 'unknown' });
    await expect(provider.stop(ref)).resolves.toBe('retryable');
    await provider.ensureLeaseAtLeast(ref, 360_000);
    await provider.logs(ref);

    expect(getSandbox).not.toHaveBeenCalled();
  });

  it('treats a missing ref without an intent as unknown', async () => {
    const getSandbox = vi.fn(() => fakeSandbox());
    const provider = createCloudflareProviderAdapter({
      sandboxId: 'sbx_1',
      getSandbox,
      destroy: async () => undefined,
    });

    await expect(provider.observe(null)).resolves.toEqual({ status: 'unknown' });
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it('keeps historical cleanup separate from a newly created containment instance', async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    const getSandbox = vi.fn(() => fakeSandbox({ destroy }));
    const provider = createCloudflareProviderAdapter({
      sandboxId: 'sbx_1',
      getSandbox,
      destroy: async () => undefined,
    });
    const providerRef = encodeCloudflareProviderRef({
      sandboxId: 'sbx_1',
      containment: true,
      instanceId: 'op_1',
    });

    const created = await provider.create({ intentId: 'op_1', createdAt: 1_000 });
    expect(created).toEqual({ providerRef });
  });
});

describe('cloudflare provider references', () => {
  it.each([true, false])('round-trips namespace %s and exact creation intent', containment => {
    const ref = { sandboxId: 'sbx_1', containment, instanceId: 'op_1' };
    expect(decodeCloudflareProviderRef(encodeCloudflareProviderRef(ref))).toEqual(ref);
  });

  it.each([
    null,
    '',
    'sbx_1',
    '{',
    'null',
    '[]',
    '{}',
    JSON.stringify({ sandboxId: 'sbx_1', containment: true }),
    JSON.stringify({ sandboxId: 'sbx_1', containment: true, instanceId: '' }),
    JSON.stringify({ sandboxId: 'sbx_1', containment: true, instanceId: 1 }),
    JSON.stringify({ sandboxId: 'sbx_1', containment: 'true', instanceId: 'op_1' }),
    JSON.stringify({ sandboxId: 'sbx_1', containment: 'false', instanceId: 'op_1' }),
    JSON.stringify({ sandboxId: '', containment: true, instanceId: 'op_1' }),
    JSON.stringify({ sandboxId: 'sbx_1', containment: true, instanceId: 'op_1', extra: true }),
    JSON.stringify({ sandboxId: 'a'.repeat(257), containment: true, instanceId: 'op_1' }),
    JSON.stringify({ sandboxId: 'sbx_1', containment: true, instanceId: 'a'.repeat(129) }),
  ])('rejects incomplete or invalid encoded refs', ref => {
    expect(decodeCloudflareProviderRef(ref)).toBeNull();
  });
});
