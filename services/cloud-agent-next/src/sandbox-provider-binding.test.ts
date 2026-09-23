import { describe, expect, it } from 'vitest';
import {
  bindingFromLegacyProvider,
  isManagedContainerBillingExempt,
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

  it('pins the complete on-prem target and rejects legacy conversion', () => {
    const binding = {
      kind: 'onprem',
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      installationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      profileId: 'gvisor',
    } as const;
    expect(SandboxProviderBindingSchema.parse(binding)).toEqual(binding);
    expect(providerKindFromBinding(binding)).toBe('onprem');
    expect(sameSandboxProviderBinding(binding, { ...binding })).toBe(true);
    const mixedCase = {
      ...binding,
      organizationId: binding.organizationId.toUpperCase(),
      installationId: binding.installationId.toUpperCase(),
    };
    expect(SandboxProviderBindingSchema.parse(mixedCase)).toEqual(binding);
    expect(sameSandboxProviderBinding(binding, mixedCase)).toBe(true);
    for (const changed of [
      { ...binding, organizationId: '33333333-3333-4333-8333-333333333333' },
      { ...binding, installationId: '33333333-3333-4333-8333-333333333333' },
      { ...binding, profileId: 'different' },
    ]) {
      expect(sameSandboxProviderBinding(binding, changed)).toBe(false);
    }
    expect(
      SandboxProviderBindingSchema.safeParse({ ...binding, profileId: undefined }).success
    ).toBe(false);
    expect(() => bindingFromLegacyProvider('onprem')).toThrow('explicit provider binding');
    expect(isManagedContainerBillingExempt(binding)).toBe(true);
    expect(isManagedContainerBillingExempt(bindingFromLegacyProvider('cloudflare'))).toBe(false);
    expect(isManagedContainerBillingExempt(bindingFromLegacyProvider('vercel'))).toBe(false);
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
