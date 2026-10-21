import { describe, expect, test } from '@jest/globals';
import { getDirectByokProviderListings } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { DIRECT_BYOK_PROVIDERS_META } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/direct-byok-meta';

describe('getDirectByokProviderListings', () => {
  const listings = getDirectByokProviderListings();

  test('lists only direct BYOK providers without a general provider counterpart', () => {
    expect(listings.map(listing => listing.slug).sort()).toEqual([
      'edenai',
      'martian',
      'neuralwatt',
      'ollama-cloud',
      'opencode-go',
      'orcarouter',
      'synthetic',
    ]);
  });

  test('names listings after the direct BYOK display names', () => {
    for (const listing of listings) {
      const name =
        DIRECT_BYOK_PROVIDERS_META[listing.slug as keyof typeof DIRECT_BYOK_PROVIDERS_META];
      expect(listing.name).toBe(name);
      expect(listing.displayName).toBe(name);
    }
  });

  test('links terms and privacy policies over https', () => {
    for (const { dataPolicy } of listings) {
      expect(dataPolicy.termsOfServiceURL).toMatch(/^https:\/\//);
      expect(dataPolicy.privacyPolicyURL).toMatch(/^https:\/\//);
    }
  });
});
