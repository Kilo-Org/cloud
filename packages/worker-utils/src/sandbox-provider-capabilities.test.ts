import { describe, expect, it } from 'vitest';
import { sandboxAllocationSchema, getSandboxAllocationProvider } from './sandbox-allocation';
import {
  SANDBOX_PROVIDER_CAPABILITIES,
  SANDBOX_PROVIDER_FEATURES,
  egressRequestSupported,
  providerSupports,
  type EgressRequest,
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
    expect(providerSupports('cloudflare-containers', 'egressProxy')).toBe(true);
    expect(providerSupports('vercel', 'environmentSnapshots')).toBe(true);
    expect(providerSupports('vercel', 'meteredBilling')).toBe(false);
    expect(providerSupports('cloudflare', 'preview')).toBe(false);
  });

  it('supports no feature for a provider id that is not in the table', () => {
    const unknown = 'newer-provider' as SandboxProviderId;
    expect(() => providerSupports(unknown, 'egressProxy')).not.toThrow();
    expect(providerSupports(unknown, 'egressProxy')).toBe(false);
  });
});

describe('egressRequestSupported', () => {
  const requests: readonly EgressRequest[] = [
    {},
    { egressMode: 'unrestricted' },
    { egressMode: 'allowlist' },
    { egressMode: 'allowlist', egressAudit: true },
    { egressAudit: true },
    { egressMode: 'unrestricted', egressAudit: true },
  ];
  // One column for each request above, in the same order.
  const expected: Record<SandboxProviderId, readonly boolean[]> = {
    'cloudflare-containers': [true, true, true, true, true, true],
    vercel: [true, true, false, false, false, false],
    cloudflare: [true, true, false, false, false, false],
  };

  it.each(
    Object.entries(expected).flatMap(([provider, row]) =>
      requests.map(
        (request, index) => [provider, JSON.stringify(request), request, row[index]] as const
      )
    )
  )('%s with %s gives the table value', (provider, _name, request, value) => {
    expect(egressRequestSupported(provider as SandboxProviderId, request)).toBe(value);
  });

  it('supports only a session without a request for an unknown provider', () => {
    const unknown = 'newer-provider' as SandboxProviderId;
    expect(egressRequestSupported(unknown, {})).toBe(true);
    expect(egressRequestSupported(unknown, { egressMode: 'allowlist' })).toBe(false);
    expect(egressRequestSupported(unknown, { egressAudit: true })).toBe(false);
  });
});
