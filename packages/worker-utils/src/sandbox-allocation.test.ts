import { describe, expect, it } from 'vitest';
import {
  SELECTABLE_SANDBOX_ALLOCATIONS,
  getSandboxAllocationProvider,
  getSandboxAllocationResources,
  getSandboxAllocationRequest,
  getSandboxAllocationKey,
  getKiloSandboxAllocation,
  sandboxAllocationInputSchema,
  sandboxAllocationRequestSchema,
  selectableSandboxAllocationInputSchema,
  isSelectableSandboxAllocation,
  sandboxAllocationRequiresControlPlane,
  sandboxAllocationSchema,
  sandboxSelectionCapabilitiesSchema,
  vercelSandboxResourcesSchema,
} from './sandbox-allocation.js';

describe('sandbox allocation contract', () => {
  it.each(sandboxAllocationSchema.options)(
    'normalizes legacy %s to its structured request',
    allocation => {
      const request = getSandboxAllocationRequest(allocation);
      expect(sandboxAllocationInputSchema.parse(allocation)).toEqual(request);
      expect(sandboxAllocationInputSchema.parse(request)).toEqual(request);
      expect(getKiloSandboxAllocation(request)).toBe(allocation);
    }
  );

  it('keeps BYOC distinct from Kilo compute with the same instance type', () => {
    const byoc = sandboxAllocationRequestSchema.parse({
      provider: { id: 'vercel', account: 'byoc' },
      instanceType: 'small',
    });
    const kilo = getSandboxAllocationRequest('vercel-small');
    expect(getSandboxAllocationKey(byoc)).not.toBe(getSandboxAllocationKey(kilo));
    expect(getKiloSandboxAllocation(byoc)).toBeUndefined();
    expect(selectableSandboxAllocationInputSchema.parse(byoc)).toEqual(byoc);
  });

  it.each([
    { provider: { id: 'vercel', account: 'kilo' }, instanceType: 'shared' },
    { provider: { id: 'cloudflare', account: 'kilo' }, instanceType: 'large' },
    { provider: { id: 'cloudflare', account: 'byoc' }, instanceType: 'single' },
    { provider: { id: 'vercel', account: 'platform' }, instanceType: 'small' },
    { provider: { id: 'vercel' }, instanceType: 'small' },
    { provider: { id: 'vercel', account: 'kilo', token: 'not-allowed' }, instanceType: 'small' },
    { provider: { id: 'vercel', account: 'kilo' }, instanceType: 'small', vcpus: 2 },
    { provider: { id: 'vercel', account: 'kilo' }, instanceType: 'default' },
    { provider: { id: 'cloudflare', account: 'kilo' }, instanceType: 'devcontainer' },
  ])('rejects unsupported provider metadata and instance combinations %j', request => {
    expect(sandboxAllocationInputSchema.safeParse(request).success).toBe(false);
  });

  it('keeps structured Dedicated Standard out of the manual choices', () => {
    const request = getSandboxAllocationRequest('isolated-standard');
    expect(sandboxAllocationInputSchema.parse(request)).toEqual(request);
    expect(selectableSandboxAllocationInputSchema.safeParse(request).success).toBe(false);
  });

  it('reads legacy capabilities as structured choices without inventing a default', () => {
    const capabilities = sandboxSelectionCapabilitiesSchema.parse({
      enabled: true,
      options: [{ allocation: 'vercel-small', available: true }],
    });
    expect(capabilities).toEqual({
      enabled: true,
      options: [{ allocation: getSandboxAllocationRequest('vercel-small'), available: true }],
    });
  });

  it('accepts provider-default and devcontainer descriptions without making them selectable', () => {
    for (const defaultDestination of [
      { provider: { id: 'vercel', account: 'kilo' }, instanceType: 'default' },
      { provider: { id: 'cloudflare', account: 'kilo' }, instanceType: 'devcontainer' },
    ]) {
      const capabilities = sandboxSelectionCapabilitiesSchema.parse({
        enabled: true,
        options: [],
        defaultDestination,
      });
      expect(capabilities.defaultDestination).toEqual(defaultDestination);
    }
  });

  it.each([
    ['vercel-small', { vcpus: 2, memory: 4096 }],
    ['vercel-large', { vcpus: 4, memory: 8192 }],
    ['cloudflare-single', undefined],
    ['cloudflare-shared', undefined],
    ['isolated-standard', undefined],
    [undefined, undefined],
  ] as const)('maps %s to fixed provider resources', (preset, resources) => {
    expect(getSandboxAllocationResources(preset)).toEqual(resources);
    if (resources) expect(vercelSandboxResourcesSchema.parse(resources)).toEqual(resources);
  });

  it.each([
    { vcpus: 2, memory: 8192 },
    { vcpus: 4, memory: 4096 },
    { vcpus: 1, memory: 2048 },
    { vcpus: 2, memory: 4096, disk: 20 },
    { vcpus: '2', memory: 4096 },
  ])('rejects unsupported resource pairs %j', resources => {
    expect(vercelSandboxResourcesSchema.safeParse(resources).success).toBe(false);
  });

  it.each([
    ['isolated-standard', 'cloudflare', false],
    ['cloudflare-single', 'cloudflare', false],
    ['cloudflare-shared', 'cloudflare', false],
    ['vercel-small', 'vercel', true],
    ['vercel-large', 'vercel', true],
  ] as const)(
    'maps %s to provider %s and control-plane requirement %s',
    (preset, provider, forcesPlane) => {
      expect(getSandboxAllocationProvider(preset)).toBe(provider);
      expect(sandboxAllocationRequiresControlPlane(preset)).toBe(forcesPlane);
    }
  );

  it('leaves an omitted selection to the existing plane decision', () => {
    expect(sandboxAllocationRequiresControlPlane(undefined)).toBe(false);
  });

  it('rejects arbitrary allocations and capability options', () => {
    expect(sandboxAllocationSchema.safeParse('vercel-custom').success).toBe(false);
    expect(
      sandboxSelectionCapabilitiesSchema.safeParse({
        enabled: true,
        options: [{ allocation: 'custom', available: true }],
      }).success
    ).toBe(false);
  });

  it('keeps isolated-standard in the field but out of the selectable set', () => {
    expect(sandboxAllocationSchema.safeParse('isolated-standard').success).toBe(true);
    expect(isSelectableSandboxAllocation('isolated-standard')).toBe(false);
    expect(SELECTABLE_SANDBOX_ALLOCATIONS).not.toContain('isolated-standard');
    expect(
      sandboxSelectionCapabilitiesSchema.safeParse({
        enabled: true,
        options: [{ allocation: 'isolated-standard', available: true }],
      }).success
    ).toBe(false);
  });

  it.each(SELECTABLE_SANDBOX_ALLOCATIONS)('treats %s as selectable', allocation => {
    expect(isSelectableSandboxAllocation(allocation)).toBe(true);
  });

  it('requires disabled capability results to omit all options', () => {
    expect(sandboxSelectionCapabilitiesSchema.parse({ enabled: false, options: [] })).toEqual({
      enabled: false,
      options: [],
    });
    expect(
      sandboxSelectionCapabilitiesSchema.safeParse({
        enabled: false,
        options: [{ allocation: 'vercel-small', available: false }],
      }).success
    ).toBe(false);
  });
});
