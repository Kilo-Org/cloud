import { describe, expect, it } from 'vitest';

import '@/i18n';
import {
  formatSandboxDefaultLabel,
  formatSandboxInstanceLabel,
  formatSandboxOptionLabel,
  formatSandboxProviderLabel,
  isSameSandboxAllocation,
  resolveSandboxOptionGroups,
  resolveSandboxSelectionError,
  type SandboxAllocation,
  sandboxAllocationKey,
  type SandboxSelectionCapabilities,
} from './sandbox-allocation-label';

const CLOUDFLARE = { provider: { id: 'cloudflare', account: 'kilo' } } as const;
const VERCEL = { provider: { id: 'vercel', account: 'kilo' } } as const;

const CLOUDFLARE_SINGLE: SandboxAllocation = { ...CLOUDFLARE, instanceType: 'single' };
const CLOUDFLARE_SHARED: SandboxAllocation = { ...CLOUDFLARE, instanceType: 'shared' };
const VERCEL_SMALL: SandboxAllocation = { ...VERCEL, instanceType: 'small' };
const VERCEL_LARGE: SandboxAllocation = { ...VERCEL, instanceType: 'large' };

function capabilities(
  options: SandboxAllocation[],
  overrides: Partial<SandboxSelectionCapabilities> = {}
): SandboxSelectionCapabilities {
  return {
    enabled: true,
    defaultDestination: CLOUDFLARE_SINGLE,
    options: options.map(allocation => ({ allocation })),
    ...overrides,
  };
}

describe('sandbox allocation labels', () => {
  it('names each provider without the account', () => {
    expect(formatSandboxProviderLabel(CLOUDFLARE_SINGLE)).toBe('Cloudflare');
    expect(formatSandboxProviderLabel(VERCEL_SMALL)).toBe('Vercel');
  });

  it.each([
    [CLOUDFLARE_SINGLE, 'Small'],
    [VERCEL_SMALL, 'Small'],
    [CLOUDFLARE_SHARED, 'Shared'],
    [VERCEL_LARGE, 'Large'],
  ] as const)('names $instanceType instances', (allocation, expected) => {
    expect(formatSandboxInstanceLabel(allocation)).toBe(expected);
  });

  it('names the devcontainer and provider-default destinations the backend can return', () => {
    expect(formatSandboxInstanceLabel({ ...CLOUDFLARE, instanceType: 'devcontainer' })).toBe(
      'Dev container'
    );
    expect(formatSandboxInstanceLabel({ ...VERCEL, instanceType: 'default' })).toBe(
      'Provider default'
    );
  });

  it('falls back to the raw instance type for a destination the picker never offers', () => {
    expect(formatSandboxInstanceLabel({ ...CLOUDFLARE, instanceType: 'isolated-standard' })).toBe(
      'isolated-standard'
    );
  });

  it('renders an option as provider and instance', () => {
    expect(formatSandboxOptionLabel(CLOUDFLARE_SINGLE)).toBe('Cloudflare · Small');
    expect(formatSandboxOptionLabel(VERCEL_LARGE)).toBe('Vercel · Large');
  });

  it('renders the backend default beside its destination and bare when there is none', () => {
    expect(formatSandboxDefaultLabel(CLOUDFLARE_SINGLE)).toBe('Default · Cloudflare · Small');
    expect(formatSandboxDefaultLabel(undefined)).toBe('Default');
  });
});

describe('sandbox allocation identity', () => {
  it('keys an allocation by provider, account, and instance type', () => {
    expect(sandboxAllocationKey(CLOUDFLARE_SINGLE)).toBe('cloudflare:kilo:single');
    expect(sandboxAllocationKey(VERCEL_LARGE)).toBe('vercel:kilo:large');
  });

  it('matches allocations by identity, never by object reference', () => {
    expect(isSameSandboxAllocation(CLOUDFLARE_SINGLE, { ...CLOUDFLARE_SINGLE })).toBe(true);
    expect(isSameSandboxAllocation(CLOUDFLARE_SINGLE, CLOUDFLARE_SHARED)).toBe(false);
    expect(isSameSandboxAllocation(undefined, undefined)).toBe(false);
    expect(isSameSandboxAllocation(CLOUDFLARE_SINGLE, undefined)).toBe(false);
  });
});

describe('sandbox option groups', () => {
  it('renders exactly the backend option set, grouped per provider', () => {
    const caps = capabilities([CLOUDFLARE_SINGLE, VERCEL_SMALL, CLOUDFLARE_SHARED]);
    const groups = resolveSandboxOptionGroups(caps);

    expect(groups.map(group => group.label)).toEqual(['Cloudflare', 'Vercel']);
    // Grouping only reorders by provider: every rendered row is one the
    // backend advertised, and no backend option is dropped or invented.
    const rendered = groups.flatMap(group => group.options);
    expect(rendered).toHaveLength(caps.options.length);
    expect(rendered.every(option => caps.options.includes(option))).toBe(true);
    expect(new Set(rendered.map(option => sandboxAllocationKey(option.allocation)))).toEqual(
      new Set(caps.options.map(option => sandboxAllocationKey(option.allocation)))
    );
    // No invented type: the rendered instance types are exactly the offered ones.
    expect(new Set(rendered.map(option => option.allocation.instanceType))).toEqual(
      new Set(caps.options.map(option => option.allocation.instanceType))
    );
  });

  it('renders nothing when the capabilities are disabled', () => {
    expect(resolveSandboxOptionGroups({ enabled: false, options: [] })).toEqual([]);
  });

  it('renders nothing when the capabilities are missing or carry no options', () => {
    expect(resolveSandboxOptionGroups(undefined)).toEqual([]);
    expect(resolveSandboxOptionGroups(capabilities([]))).toEqual([]);
  });
});

describe('sandbox selection errors', () => {
  const caps = capabilities([CLOUDFLARE_SINGLE, VERCEL_SMALL]);

  it('accepts the backend default when nothing is picked', () => {
    expect(
      resolveSandboxSelectionError({ capabilities: caps, allocation: undefined })
    ).toBeUndefined();
  });

  it('accepts a picked allocation the backend offers', () => {
    expect(
      resolveSandboxSelectionError({ capabilities: caps, allocation: VERCEL_SMALL })
    ).toBeUndefined();
  });

  it('reports a pick while the owner cannot select a sandbox', () => {
    expect(
      resolveSandboxSelectionError({
        capabilities: { enabled: false, options: [] },
        allocation: CLOUDFLARE_SINGLE,
      })
    ).toBe('selection-unavailable');
  });

  it('reports a pick the backend no longer offers', () => {
    expect(resolveSandboxSelectionError({ capabilities: caps, allocation: VERCEL_LARGE })).toBe(
      'not-offered'
    );
  });

  it('treats missing capabilities with a pick as unavailable', () => {
    expect(
      resolveSandboxSelectionError({ capabilities: undefined, allocation: CLOUDFLARE_SINGLE })
    ).toBe('selection-unavailable');
  });
});
