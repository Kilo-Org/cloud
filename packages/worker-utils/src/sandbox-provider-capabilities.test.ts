import { describe, expect, it } from 'vitest';
import { sandboxAllocationSchema, getSandboxAllocationProvider } from './sandbox-allocation';
import {
  SANDBOX_PROVIDER_CAPABILITIES,
  SANDBOX_PROVIDER_FEATURES,
  providerSupports,
  type SandboxProviderId,
} from './sandbox-provider-capabilities';

describe('sandbox provider capability table', () => {
  it('has an entry for every provider in the allocation catalog', () => {
    const catalogProviders = new Set(
      sandboxAllocationSchema.options.map(allocation => getSandboxAllocationProvider(allocation))
    );
    expect(Object.keys(SANDBOX_PROVIDER_CAPABILITIES).sort()).toEqual([...catalogProviders].sort());
  });

  it('declares every feature, and only those, for each provider', () => {
    for (const features of Object.values(SANDBOX_PROVIDER_CAPABILITIES)) {
      expect(Object.keys(features).sort()).toEqual([...SANDBOX_PROVIDER_FEATURES].sort());
    }
  });

  it('reads the table through providerSupports', () => {
    expect(providerSupports('cloudflare-containers', 'egressPolicy')).toBe(true);
    expect(providerSupports('vercel', 'environmentSnapshots')).toBe(true);
    expect(providerSupports('vercel', 'meteredBilling')).toBe(false);
    expect(providerSupports('cloudflare', 'preview')).toBe(false);
  });

  it('supports no feature for a provider id that is not in the table', () => {
    const unknown = 'newer-provider' as SandboxProviderId;
    expect(() => providerSupports(unknown, 'egressPolicy')).not.toThrow();
    expect(providerSupports(unknown, 'egressPolicy')).toBe(false);
  });
});
