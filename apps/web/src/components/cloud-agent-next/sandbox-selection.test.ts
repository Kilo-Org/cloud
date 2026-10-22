import { describe, expect, it } from '@jest/globals';
import {
  getSandboxAllocationRequest,
  type SandboxDestination,
  type SandboxSelectionCapabilities,
  type SelectableSandboxAllocationRequest,
} from '@kilocode/worker-utils/sandbox-allocation';
import {
  formatSandboxCapacity,
  formatSandboxInstance,
  getSandboxSelectionOptions,
} from './sandbox-selection';

const vercelLarge = getSandboxAllocationRequest('vercel-large');
const byocLarge = {
  provider: { id: 'vercel', account: 'byoc' },
  instanceType: 'large',
} satisfies SelectableSandboxAllocationRequest;
const capabilities: SandboxSelectionCapabilities = {
  enabled: true,
  options: [{ allocation: structuredClone(vercelLarge) }],
};

describe('formatSandboxCapacity', () => {
  it.each([
    [getSandboxAllocationRequest('cloudflare-single'), '2 vCPU / 6 GiB'],
    [getSandboxAllocationRequest('cloudflare-shared'), '4 vCPU / 12 GiB'],
    [getSandboxAllocationRequest('cloudflare-containers-standard-3'), '2 vCPU / 8 GiB'],
    [getSandboxAllocationRequest('cloudflare-containers-standard-4'), '4 vCPU / 12 GiB'],
    [getSandboxAllocationRequest('isolated-standard'), '4 vCPU / 12 GiB'],
    [getSandboxAllocationRequest('vercel-small'), '2 vCPU / 4 GiB'],
    [byocLarge, '4 vCPU / 8 GiB'],
    [{ provider: { id: 'vercel', account: 'kilo' }, instanceType: 'default' }, 'Provider default'],
  ] satisfies Array<[SandboxDestination, string]>)(
    'reports the vCPU and memory a destination runs with: %j',
    (destination, label) => {
      expect(formatSandboxCapacity(destination)).toBe(label);
    }
  );
});

describe('formatSandboxInstance', () => {
  it.each([
    [getSandboxAllocationRequest('cloudflare-single'), '2 vCPU / 6 GiB · Small'],
    [getSandboxAllocationRequest('cloudflare-shared'), '4 vCPU / 12 GiB · Large · Shared'],
    [getSandboxAllocationRequest('cloudflare-containers-standard-3'), '2 vCPU / 8 GiB · Medium'],
    [getSandboxAllocationRequest('cloudflare-containers-standard-4'), '4 vCPU / 12 GiB · Large'],
    [getSandboxAllocationRequest('vercel-small'), '2 vCPU / 4 GiB · Small'],
    [byocLarge, '4 vCPU / 8 GiB · Medium'],
    [{ provider: { id: 'vercel', account: 'kilo' }, instanceType: 'default' }, 'Provider default'],
  ] satisfies Array<[SandboxDestination, string]>)(
    'formats an instance without repeating its account/provider heading: %j',
    (destination, label) => {
      expect(formatSandboxInstance(destination)).toBe(label);
    }
  );

  it('adds the tenancy tier that capacity alone cannot separate', () => {
    const shared = getSandboxAllocationRequest('cloudflare-shared');
    const dedicated = getSandboxAllocationRequest('isolated-standard');
    expect(formatSandboxCapacity(shared)).toBe(formatSandboxCapacity(dedicated));
    expect(formatSandboxInstance(shared)).not.toBe(formatSandboxInstance(dedicated));
  });
});

describe('getSandboxSelectionOptions', () => {
  it('places BYOC before Kilo and gathers each provider without reordering instances', () => {
    const options: SandboxSelectionCapabilities['options'] = [
      { allocation: vercelLarge },
      { allocation: byocLarge },
      { allocation: getSandboxAllocationRequest('cloudflare-shared') },
      { allocation: { ...byocLarge, instanceType: 'small' } },
      { allocation: getSandboxAllocationRequest('vercel-small') },
      { allocation: getSandboxAllocationRequest('cloudflare-single') },
    ];
    const originalOrder = [...options];
    expect(getSandboxSelectionOptions({ enabled: true, options })).toEqual([
      options[1],
      options[3],
      options[2],
      options[5],
      options[0],
      options[4],
    ]);
    expect(options).toEqual(originalOrder);
  });

  it('does not invent BYOC options when the Worker only offers Kilo', () => {
    expect(getSandboxSelectionOptions(capabilities)).toEqual(capabilities.options);
    expect(getSandboxSelectionOptions(undefined)).toEqual([]);
    expect(getSandboxSelectionOptions({ enabled: false, options: [] })).toEqual([]);
  });
});
