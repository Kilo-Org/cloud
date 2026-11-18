import { describe, expect, it } from 'vitest';
import {
  decodeCloudflareProviderRef,
  encodeCloudflareProviderRef,
  providerRefSchema,
} from './provider-ref.js';

describe('Cloudflare provider ref codec', () => {
  it('round-trips the strict provider ref shape as JSON', () => {
    const ref = { sandboxId: 'ses-abcdef', containment: true, instanceId: 'attempt-1' };
    const encoded = encodeCloudflareProviderRef(ref);

    expect(JSON.parse(encoded)).toEqual(ref);
    expect(decodeCloudflareProviderRef(encoded)).toEqual(ref);
  });

  it('rejects extra fields and malformed JSON instead of widening the stored pin', () => {
    expect(
      providerRefSchema.safeParse({
        sandboxId: 'ses-abcdef',
        containment: false,
        instanceId: 'attempt-1',
        extra: true,
      }).success
    ).toBe(false);
    expect(
      decodeCloudflareProviderRef(
        JSON.stringify({ sandboxId: 'ses-abcdef', containment: false, instanceId: 'a', extra: 1 })
      )
    ).toBeNull();
    expect(decodeCloudflareProviderRef('not-json')).toBeNull();
    expect(decodeCloudflareProviderRef(null)).toBeNull();
  });
});
