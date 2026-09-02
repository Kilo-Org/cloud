import { describe, expect, it } from 'vitest';
import { createMemoryProviderAdapter, observeFromWrapperObservation } from './provider.js';

const OBSERVE_RESULTS = ['active', 'terminal', 'unknown'] as const;

describe('observeFromWrapperObservation', () => {
  it('maps inspection-failed to unknown, not a boolean', () => {
    expect(observeFromWrapperObservation('inspection-failed')).toBe('unknown');
    expect(observeFromWrapperObservation('absent')).toBe('terminal');
    expect(observeFromWrapperObservation('present')).toBe('active');
  });
});

describe('memory provider adapter', () => {
  it('declares the resumable bit', () => {
    expect(createMemoryProviderAdapter().resumable).toBe(false);
    expect(createMemoryProviderAdapter({ resumable: true }).resumable).toBe(true);
  });

  it('observe never returns a boolean', async () => {
    const provider = createMemoryProviderAdapter();
    const created = await provider.create({ intentId: 'a', createdAt: 1_000 });
    if (!('providerRef' in created)) throw new Error('expected providerRef');

    const results = [
      await provider.observe(null),
      await provider.observe('mem_missing'),
      await provider.observe(created.providerRef),
    ];
    await provider.stop(created.providerRef);
    results.push(await provider.observe(created.providerRef));

    for (const result of results) {
      expect(typeof result).not.toBe('boolean');
      expect(OBSERVE_RESULTS).toContain(result.status);
    }
  });

  it('create then observe is active', async () => {
    const provider = createMemoryProviderAdapter();
    await expect(provider.create({ intentId: 'a', createdAt: 1_000 })).resolves.toEqual({
      providerRef: 'mem_a',
    });
    await expect(provider.observe('mem_a')).resolves.toEqual({
      status: 'active',
      providerRef: 'mem_a',
    });
  });

  it('stop then observe is terminal', async () => {
    const provider = createMemoryProviderAdapter();
    await provider.create({ intentId: 'a', createdAt: 1_000 });
    await expect(provider.stop('mem_a')).resolves.toBe('terminal');
    await expect(provider.observe('mem_a')).resolves.toEqual({
      status: 'terminal',
      providerRef: 'mem_a',
    });
  });

  it('observe(null) on an empty adapter is terminal (successful not-found)', async () => {
    const provider = createMemoryProviderAdapter();
    await expect(provider.observe(null)).resolves.toEqual({ status: 'terminal' });
  });

  it('ensureLeaseAtLeast stores the requested ms', async () => {
    const provider = createMemoryProviderAdapter();
    await provider.ensureLeaseAtLeast('mem_a', 30_000);
    expect(provider.lastLeaseMs).toBe(30_000);
  });
});
