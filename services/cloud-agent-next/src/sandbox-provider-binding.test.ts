import { describe, expect, it } from 'vitest';
import {
  bindingFromLegacyProvider,
  providerKindFromBinding,
  sameSandboxProviderBinding,
  SandboxProviderBindingSchema,
} from './sandbox-provider-binding.js';

describe('SandboxProviderBinding', () => {
  it('accepts each closed provider source and preserves its identity', () => {
    const bindings = [
      { kind: 'cloudflare' },
      { kind: 'vercel', source: { kind: 'platform' } },
      {
        kind: 'vercel',
        source: {
          kind: 'byoc',
          organizationId: 'org-1',
          credentialId: 'credential-1',
        },
      },
    ] as const;

    for (const binding of bindings) {
      expect(SandboxProviderBindingSchema.parse(binding)).toEqual(binding);
      expect(providerKindFromBinding(binding)).toBe(binding.kind);
    }
  });

  it('maps legacy provider strings only to platform sources', () => {
    expect(bindingFromLegacyProvider('cloudflare')).toEqual({ kind: 'cloudflare' });
    expect(bindingFromLegacyProvider('vercel')).toEqual({
      kind: 'vercel',
      source: { kind: 'platform' },
    });
  });

  it('pins BYOC organization and credential identity', () => {
    const binding = {
      kind: 'vercel' as const,
      source: { kind: 'byoc' as const, organizationId: 'org-1', credentialId: 'credential-1' },
    };
    expect(sameSandboxProviderBinding(binding, { ...binding })).toBe(true);
    expect(
      sameSandboxProviderBinding(binding, {
        ...binding,
        source: { ...binding.source, credentialId: 'credential-2' },
      })
    ).toBe(false);
    expect(
      SandboxProviderBindingSchema.safeParse({ kind: 'vercel', source: { kind: 'byoc' } }).success
    ).toBe(false);
  });
});
