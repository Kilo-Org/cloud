import { describe, expect, it } from 'vitest';
import { assertNetworkSecretAllocation } from './network-secret-storage';

describe('assertNetworkSecretAllocation', () => {
  it.each(['cloudflare-single', 'cloudflare-containers-standard-3'])(
    'accepts an allocation that resolves to native Cloudflare Containers: %s',
    allocation => {
      expect(() => assertNetworkSecretAllocation(1, allocation)).not.toThrow();
    }
  );

  it.each(['cloudflare-shared', 'vercel-small'])(
    'rejects an allocation that does not resolve to Cloudflare Containers: %s',
    allocation => {
      expect(() => assertNetworkSecretAllocation(1, allocation)).toThrow(
        'Network secrets require a Cloudflare sandbox'
      );
    }
  );
});
