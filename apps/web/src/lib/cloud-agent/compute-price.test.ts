import { describe, expect, it } from '@jest/globals';
import { getSandboxAllocationRequest } from '@kilocode/worker-utils/sandbox-allocation';
import { computePriceNote, kiloContainersInstance } from './compute-price';

describe('kiloContainersInstance', () => {
  it('returns the instance of a Kilo-hosted container only', () => {
    expect(
      kiloContainersInstance(getSandboxAllocationRequest('cloudflare-containers-standard-4'))
    ).toBe('standard-4');
    expect(kiloContainersInstance(getSandboxAllocationRequest('vercel-small'))).toBeNull();
    expect(kiloContainersInstance(undefined)).toBeNull();
  });
});

const rate = { hourlyUsd: 0.18, available: true };

describe('computePriceNote', () => {
  it('labels a shadow-mode price as upcoming', () => {
    expect(computePriceNote('shadow', rate)).toEqual({
      label: 'Upcoming compute price',
      price: '~$0.18/hr',
    });
  });

  it('labels a charged price as the compute price', () => {
    expect(computePriceNote('paid', rate)).toEqual({ label: 'Compute price', price: '~$0.18/hr' });
  });

  it.each([
    ['the billing mode is unknown', undefined, rate],
    ['the rate is unknown', 'shadow', undefined],
    ['the SKU accepts no new usage', 'shadow', { hourlyUsd: 0.18, available: false }],
    ['the SKU has no price', 'paid', { hourlyUsd: null, available: true }],
    ['the price is zero', 'paid', { hourlyUsd: 0, available: true }],
  ] as const)('shows nothing when %s', (_case, billingMode, candidate) => {
    expect(computePriceNote(billingMode, candidate)).toBeNull();
  });
});
