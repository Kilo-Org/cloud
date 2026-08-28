import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTimeout } from '@kilocode/worker-utils';
import {
  forceDestroyControlPlaneSandbox,
  parseSandboxBillingInput,
  type MeteredSandboxInstance,
} from '../container-usage-context.js';
import { deriveSandboxAllocationId } from '../sandbox-id.js';
import { createCloudflareProviderAdapter } from './cloudflare-provider.js';
import { DEADLINE_MS } from './deadlines.js';

function fakeSandbox(overrides: Partial<MeteredSandboxInstance> = {}): MeteredSandboxInstance {
  return {
    renewActivityTimeout: () => undefined,
    destroy: async () => undefined,
    isContainerRunning: async () => true,
    startProcess: async () => ({ id: 'proc_1' }),
    configureBilling: async () => undefined,
    isBillingBlocked: async () => false,
    ensureBillingAdmission: async () => ({ success: true }),
    ...overrides,
  } as MeteredSandboxInstance;
}

const logicalId = 'ses-abcdef';
const intent = { intentId: 'op_1', createdAt: 1_000, allocationName: 'ses-123abc' };
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
  it('returns the physical identity without waking, then launches against that identity', async () => {
    const startProcess = vi.fn().mockResolvedValue({ id: 'proc_1' });
    const getSandbox = vi.fn(() => fakeSandbox({ startProcess }));
    const provider = createCloudflareProviderAdapter({
      sandboxId: logicalId,
      getSandbox,
      destroy: async () => undefined,
    });
    const created = await provider.create(intent);
    expect(created).toEqual({ providerRef: intent.allocationName });
    expect(getSandbox).not.toHaveBeenCalled();
    expect(startProcess).not.toHaveBeenCalled();

    await provider.launch(intent.allocationName, {
      SANDBOX_CONTROL_URL: `wss://example.test/sandbox-control/${logicalId}`,
      SANDBOX_CONTROL_CREDENTIAL: 'test-credential',
    });
    expect(getSandbox).toHaveBeenCalledWith(intent.allocationName);
    expect(startProcess).toHaveBeenCalledWith(
      'bun run /usr/local/bin/kilocode-control-wrapper.js',
      {
        cwd: '/',
        env: {
          SANDBOX_CONTROL_URL: `wss://example.test/sandbox-control/${logicalId}`,
          SANDBOX_CONTROL_CREDENTIAL: 'test-credential',
          PROVIDER_INSTANCE_ID: intent.allocationName,
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
      sandboxId: logicalId,
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
      sandboxId: logicalId,
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
      sandboxId: logicalId,
      destroy: async () => undefined,
      getSandbox: () => sandbox,
    });
    await provider.create({ ...intent, billing: { ...billing, enforcementRequested: false } });
    await provider.launch(intent.allocationName, {});
    expect(actions).toEqual(['attributed', 'started']);
    expect(configureBilling).toHaveBeenCalledWith({
      ...billing,
      enforcementRequested: false,
      sandboxId: intent.allocationName,
    });
  });

  it('uses a distinct class-compatible allocation for create-stop-create', async () => {
    const names: string[] = [];
    const destroy = vi.fn(async () => undefined);
    const provider = createCloudflareProviderAdapter({
      sandboxId: logicalId,
      destroy,
      getSandbox: id => {
        names.push(id);
        return fakeSandbox();
      },
    });
    const first = await deriveSandboxAllocationId(logicalId, 'first');
    const second = await deriveSandboxAllocationId(logicalId, 'second');
    await provider.create({ ...intent, allocationName: first });
    await provider.launch(first, {});
    await expect(provider.stop(first)).resolves.toBe('terminal');
    await provider.create({ ...intent, intentId: 'second', allocationName: second });
    await provider.launch(second, {});
    expect(first).not.toBe(second);
    expect(names).toEqual([first, second]);
    expect(destroy).toHaveBeenCalledExactlyOnceWith(first);
    expect(first).toMatch(/^ses-[a-f0-9]{48}$/);
    expect(second).toMatch(/^ses-[a-f0-9]{48}$/);
  });

  it('observes a missing ref by its retained name without waking, and preserves settling uncertainty', async () => {
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
      sandboxId: logicalId,
      getSandbox,
      destroy: async () => undefined,
    });
    await expect(provider.observe(null, intent)).resolves.toEqual({
      status: 'active',
      providerRef: intent.allocationName,
    });
    running = false;
    await expect(provider.observe(null, intent)).resolves.toEqual({
      status: 'unknown',
      providerRef: intent.allocationName,
    });
    vi.setSystemTime(intent.createdAt + DEADLINE_MS.createSettle);
    await expect(provider.observe(null, intent)).resolves.toEqual({
      status: 'terminal',
      providerRef: intent.allocationName,
    });
    await expect(provider.observe(null)).resolves.toEqual({ status: 'unknown' });
    expect(getSandbox).toHaveBeenCalledWith(intent.allocationName);
    expect(startProcess).not.toHaveBeenCalled();
  });

  it('keeps failed observations unknown rather than treating them as physical death', async () => {
    const provider = createCloudflareProviderAdapter({
      sandboxId: logicalId,
      destroy: async () => undefined,
      getSandbox: () =>
        fakeSandbox({
          isContainerRunning: async () => {
            throw new Error('offline');
          },
        }),
    });
    await expect(provider.observe(intent.allocationName)).resolves.toEqual({
      status: 'unknown',
      providerRef: intent.allocationName,
    });
  });

  it('keeps a failed stop retryable and can later observe physical death without another start', async () => {
    let running = true;
    const startProcess = vi.fn();
    const destroy = vi.fn().mockRejectedValue(new Error('provider unavailable'));
    const provider = createCloudflareProviderAdapter({
      sandboxId: logicalId,
      destroy,
      getSandbox: () => fakeSandbox({ startProcess, isContainerRunning: async () => running }),
    });
    await expect(provider.stop(intent.allocationName)).resolves.toBe('retryable');
    await expect(provider.observe(intent.allocationName)).resolves.toEqual({
      status: 'active',
      providerRef: intent.allocationName,
    });
    running = false;
    await expect(provider.observe(intent.allocationName)).resolves.toEqual({
      status: 'terminal',
      providerRef: intent.allocationName,
    });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(startProcess).not.toHaveBeenCalled();
  });

  it.each([
    { ref: intent.allocationName, createIntent: intent, expected: intent.allocationName },
    { ref: null, createIntent: intent, expected: intent.allocationName },
    {
      ref: null,
      createIntent: { intentId: 'older-allocation', createdAt: 1_000 },
      expected: logicalId,
    },
  ])(
    'destroys allocation $expected through a raw namespace stub without SDK acquisition',
    async ({ ref, createIntent, expected }) => {
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
        sandboxId: logicalId,
        getSandbox,
        destroy: id => forceDestroyControlPlaneSandbox(namespace.getByName(id)),
      });

      await expect(provider.stop(ref, createIntent)).resolves.toBe('terminal');

      expect(runtime.running).toBe(false);
      expect(namespace.getByName).toHaveBeenCalledExactlyOnceWith(expected);
      expect(getSandbox).not.toHaveBeenCalled();
    }
  );

  it('does not destroy anything without a retained allocation identity', async () => {
    const destroy = vi.fn(async () => undefined);
    const getSandbox = vi.fn(() => fakeSandbox());
    const provider = createCloudflareProviderAdapter({ sandboxId: logicalId, getSandbox, destroy });

    await expect(provider.stop(null)).resolves.toBe('retryable');

    expect(destroy).not.toHaveBeenCalled();
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it('keeps a missing native capability retryable without falling back to SDK destruction', async () => {
    const sdkDestroy = vi.fn(async () => undefined);
    const sandbox = fakeSandbox({ destroy: sdkDestroy });
    const getSandbox = vi.fn(() => sandbox);
    const provider = createCloudflareProviderAdapter({
      sandboxId: logicalId,
      getSandbox,
      destroy: () => forceDestroyControlPlaneSandbox(sandbox),
    });

    await expect(provider.stop(intent.allocationName)).resolves.toBe('retryable');

    expect(sdkDestroy).not.toHaveBeenCalled();
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it('does not interpret a lost native stop acknowledgement as terminal success', async () => {
    let running = true;
    const startProcess = vi.fn();
    const destroy = vi.fn(async () => {
      running = false;
      throw new Error('Native destroy acknowledgement lost');
    });
    const provider = createCloudflareProviderAdapter({
      sandboxId: logicalId,
      destroy,
      getSandbox: () => fakeSandbox({ startProcess, isContainerRunning: async () => running }),
    });

    await expect(provider.stop(intent.allocationName)).resolves.toBe('retryable');
    await expect(provider.observe(intent.allocationName)).resolves.toEqual({
      status: 'terminal',
      providerRef: intent.allocationName,
    });

    expect(destroy).toHaveBeenCalledExactlyOnceWith(intent.allocationName);
    expect(startProcess).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'leaves a hanging native stop unresolved until acknowledgement, physical running: %s',
    async runningAfterIssuance => {
      vi.useFakeTimers();
      let running = true;
      const acknowledgement = Promise.withResolvers<void>();
      const destroy = vi.fn(async () => {
        running = runningAfterIssuance;
        await acknowledgement.promise;
        running = false;
      });
      const getSandbox = vi.fn(() => fakeSandbox({ isContainerRunning: async () => running }));
      const provider = createCloudflareProviderAdapter({
        sandboxId: logicalId,
        getSandbox,
        destroy,
      });
      const settled = vi.fn();
      const stopping = provider.stop(intent.allocationName).then(settled);
      const timedOut = expect(
        withTimeout(stopping, DEADLINE_MS.stopAttempt, 'Native destroy acknowledgement timed out')
      ).rejects.toThrow('Native destroy acknowledgement timed out');

      await vi.advanceTimersByTimeAsync(DEADLINE_MS.stopAttempt);
      await timedOut;

      expect(settled).not.toHaveBeenCalled();
      expect(destroy).toHaveBeenCalledExactlyOnceWith(intent.allocationName);
      expect(getSandbox).not.toHaveBeenCalled();
      await expect(provider.observe(intent.allocationName)).resolves.toEqual({
        status: runningAfterIssuance ? 'active' : 'terminal',
        providerRef: intent.allocationName,
      });
      acknowledgement.resolve();
      await stopping;
      expect(settled).toHaveBeenCalledExactlyOnceWith('terminal');
    }
  );

  it('propagates launch failure without losing the known allocation', async () => {
    const provider = createCloudflareProviderAdapter({
      sandboxId: logicalId,
      destroy: async () => undefined,
      getSandbox: () =>
        fakeSandbox({ startProcess: vi.fn().mockRejectedValue(new Error('launch failed')) }),
    });
    await expect(provider.create(intent)).resolves.toEqual({ providerRef: intent.allocationName });
    await expect(provider.launch(intent.allocationName, {})).rejects.toThrow('launch failed');
    await expect(provider.observe(intent.allocationName)).resolves.toEqual({
      status: 'active',
      providerRef: intent.allocationName,
    });
  });

  it('renews the lease on the physical ref', async () => {
    const renewed: string[] = [];
    const provider = createCloudflareProviderAdapter({
      sandboxId: logicalId,
      destroy: async () => undefined,
      getSandbox: id =>
        fakeSandbox({
          renewActivityTimeout: () => {
            renewed.push(id);
          },
        }),
    });
    await provider.ensureLeaseAtLeast(intent.allocationName, 360_000);
    expect(renewed).toEqual([intent.allocationName]);
  });
});
