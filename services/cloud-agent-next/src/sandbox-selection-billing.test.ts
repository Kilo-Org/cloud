import { describe, expect, it, vi } from 'vitest';
import type { ContainerBillingStatusRpcMethods } from '@kilocode/container-usage';
import { getSandboxAllocationRequest } from '@kilocode/worker-utils/sandbox-allocation';
import {
  assertSandboxAllocationAvailable,
  getSandboxSelectionCapabilities,
} from './sandbox-selection.js';
import { appRouter } from './router.js';
import type { Env, TRPCContext } from './types.js';

describe('billing enrollment sandbox selection', () => {
  it.each([{ userId: 'oauth/billing-user' }, { userId: 'oauth/member', orgId: 'billing-org' }])(
    'enables both native sizes for the paid owner %j',
    async owner => {
      const getBillingMode = vi.fn().mockResolvedValue('paid');
      const env = { CONTAINER_USAGE_METER: { getBillingMode } } as unknown as Env;

      const capabilities = await getSandboxSelectionCapabilities(env, owner);
      expect(capabilities.enabled).toBe(true);
      expect(getBillingMode).toHaveBeenCalledWith({
        service: 'cloud-agent-next-sandbox-containers-standard3',
        subject: owner.orgId
          ? { type: 'org', id: owner.orgId }
          : { type: 'user', id: owner.userId },
      });
      expect(capabilities.options.filter(option => !option.unavailableReason)).toEqual([
        { allocation: getSandboxAllocationRequest('cloudflare-containers-standard-3') },
        { allocation: getSandboxAllocationRequest('cloudflare-containers-standard-4') },
      ]);
      for (const allocation of [
        'cloudflare-containers-standard-3',
        'cloudflare-containers-standard-4',
      ] as const) {
        await expect(
          assertSandboxAllocationAvailable(env, owner, allocation)
        ).resolves.toBeUndefined();
      }
      await expect(assertSandboxAllocationAvailable(env, owner, 'vercel-large')).rejects.toThrow(
        'Configure Vercel BYOC'
      );
    }
  );

  it('exposes billing-enabled selection through the API', async () => {
    const env = {
      CONTAINER_USAGE_METER: { getBillingMode: vi.fn().mockResolvedValue('paid') },
    } as unknown as Env;
    const caller = appRouter.createCaller({
      env,
      userId: 'oauth/billing-user',
      authToken: 'test-token',
      request: new Request('http://localhost'),
    } as TRPCContext);

    const capabilities = await caller.getSandboxSelectionOptions({});
    expect(capabilities.enabled).toBe(true);
    expect(capabilities.options.filter(option => !option.unavailableReason)).toHaveLength(2);
  });

  it('does not grant organization selection from personal billing', async () => {
    const getBillingMode = vi.fn(
      async (input: Parameters<ContainerBillingStatusRpcMethods['getBillingMode']>[0]) =>
        input.subject.type === 'user' ? 'paid' : 'shadow'
    );
    const env = { CONTAINER_USAGE_METER: { getBillingMode } } as unknown as Env;

    await expect(
      getSandboxSelectionCapabilities(env, { userId: 'oauth/billing-user', orgId: 'unpaid-org' })
    ).resolves.toMatchObject({ enabled: false, options: [] });
  });

  it('retries a transient billing lookup failure', async () => {
    const getBillingMode = vi
      .fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue('paid');
    const env = { CONTAINER_USAGE_METER: { getBillingMode } } as unknown as Env;

    await expect(
      getSandboxSelectionCapabilities(env, { userId: 'oauth/billing-user' })
    ).resolves.toMatchObject({ enabled: true });
    expect(getBillingMode).toHaveBeenCalledTimes(2);
  });

  it('reports a billing lookup failure instead of dropping a saved size', async () => {
    const getBillingMode = vi.fn().mockRejectedValue(new Error('unavailable'));
    const env = { CONTAINER_USAGE_METER: { getBillingMode } } as unknown as Env;

    await expect(
      getSandboxSelectionCapabilities(env, { userId: 'oauth/billing-user' })
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(getBillingMode).toHaveBeenCalledTimes(2);
  });

  it('bounds a billing lookup that does not return', async () => {
    vi.useFakeTimers();
    try {
      const getBillingMode = vi.fn(() => new Promise(() => {}));
      const env = { CONTAINER_USAGE_METER: { getBillingMode } } as unknown as Env;
      const result = expect(
        getSandboxSelectionCapabilities(env, { userId: 'oauth/billing-user' })
      ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

      await vi.advanceTimersByTimeAsync(2_000);
      await result;
      expect(getBillingMode).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([{ SANDBOX_SELECTION_IDS: '*' }, { BYOC_VERCEL_IDS: '*' }])(
    'keeps existing selection independent of the meter: %j',
    async enrollment => {
      const getBillingMode = vi.fn().mockRejectedValue(new Error('unavailable'));
      const env = {
        ...enrollment,
        CONTAINER_USAGE_METER: { getBillingMode },
      } as unknown as Env;

      await expect(
        getSandboxSelectionCapabilities(env, { userId: 'oauth/enrolled-user' })
      ).resolves.toMatchObject({ enabled: true });
      expect(getBillingMode).not.toHaveBeenCalled();
    }
  );
});
