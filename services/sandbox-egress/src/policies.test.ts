import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AwsEgressPolicy } from '@kilocode/worker-utils/aws-egress';
import { createPolicyRegistry, type PolicyLease } from './policies.js';

const policy = (): AwsEgressPolicy => ({
  protocolVersion: 1,
  generation: '22222222-2222-4222-8222-222222222222',
  stackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/customer/12345678-abcd',
  sandboxId: 'sbx_test',
  allocationId: '11111111-1111-4111-8111-111111111111',
  allocationRef: 'allocation-1',
  validUntil: Date.now() + 30_000,
  audit: true,
  interceptedHosts: [],
});
afterEach(() => vi.useRealTimers());
describe('bounded proxy policy leases', () => {
  it('closes existing tunnels at the last accepted deadline when refresh fails', async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValueOnce(policy()).mockRejectedValue(new Error('offline'));
    const registry = createPolicyRegistry({ load });
    const close = vi.fn(() => lease.release());
    const lease: PolicyLease = await registry.acquire(
      'credential',
      'worker.example',
      close,
      new AbortController().signal
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(close).toHaveBeenCalledOnce();
    expect(() => lease.policy()).toThrow();
    registry.close();
  });
  it('refreshes SCM before CONNECT and closes a tunnel when the managed mode changes', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(policy())
      .mockResolvedValue({ ...policy(), interceptedHosts: ['github.com'] });
    const registry = createPolicyRegistry({ load });
    const close = vi.fn(() => old.release());
    const old: PolicyLease = await registry.acquire(
      'credential',
      'github.com',
      close,
      new AbortController().signal
    );
    const next = await registry.acquire(
      'credential',
      'github.com',
      () => {},
      new AbortController().signal
    );
    expect(load).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
    expect(next.policy().interceptedHosts).toEqual(['github.com']);
    next.release();
    registry.close();
  });
  it('bounds the cache and all credentials of the same allocation', async () => {
    const registry = createPolicyRegistry({
      load: async () => policy(),
      maxEntries: 2,
      maxConnectionsPerAllocation: 1,
    });
    const first = await registry.acquire(
      'credential-1',
      'worker.example',
      () => {},
      new AbortController().signal
    );
    await expect(
      registry.acquire('credential-2', 'worker.example', () => {}, new AbortController().signal)
    ).rejects.toThrow();
    first.release();
    const second = await registry.acquire(
      'credential-2',
      'worker.example',
      () => {},
      new AbortController().signal
    );
    expect(second.policy().allocationRef).toBe('allocation-1');
    second.release();
    registry.close();
  });
  it('does not share authenticated cache entries with a different proof', async () => {
    const load = vi.fn(async (token: string) => {
      if (token !== 'valid') throw new Error('forged');
      return policy();
    });
    const registry = createPolicyRegistry({ load });
    const first = await registry.acquire(
      'valid',
      'worker.example',
      () => {},
      new AbortController().signal
    );
    await expect(
      registry.acquire('forged', 'worker.example', () => {}, new AbortController().signal)
    ).rejects.toThrow();
    expect(load).toHaveBeenCalledTimes(2);
    first.release();
    registry.close();
  });
});
