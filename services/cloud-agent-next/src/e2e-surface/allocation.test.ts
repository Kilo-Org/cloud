import { describe, expect, it } from 'vitest';
import {
  initialAllocationState,
  type AllocationView,
} from '../control-plane/sandbox/allocation.js';
import { projectAllocationInspection } from './allocation.js';

const SANDBOX_ID = 'usr-000000000abc';

function view(overrides: Partial<AllocationView>): AllocationView {
  return { ...initialAllocationState(), provider: 'cloudflare', configuration: null, ...overrides };
}

describe('projectAllocationInspection', () => {
  it('reports nothing for a session that never owned an allocation', () => {
    expect(projectAllocationInspection(SANDBOX_ID, view({}))).toEqual({
      logicalSandboxId: SANDBOX_ID,
      physicalProviderRef: null,
      provider: 'cloudflare',
      configuration: null,
      physicalState: null,
    });
  });

  it('reports a stopped allocation without a live provider reference', () => {
    expect(
      projectAllocationInspection(SANDBOX_ID, view({ allocationId: 'alloc-1', kind: 'stopped' }))
    ).toEqual({
      logicalSandboxId: SANDBOX_ID,
      physicalProviderRef: null,
      provider: 'cloudflare',
      configuration: null,
      physicalState: 'stopped',
    });
  });

  it('reports an unconfirmed stop as unknown with the surviving reference', () => {
    expect(
      projectAllocationInspection(
        SANDBOX_ID,
        view({ kind: 'stopped', unconfirmedProviderRef: 'provider-ref-9' })
      )
    ).toEqual({
      logicalSandboxId: SANDBOX_ID,
      physicalProviderRef: 'provider-ref-9',
      provider: 'cloudflare',
      configuration: null,
      physicalState: 'unknown',
    });
  });

  it('reports creating before a provider reference exists', () => {
    expect(
      projectAllocationInspection(SANDBOX_ID, view({ kind: 'starting', allocationId: 'alloc-1' }))
    ).toEqual({
      logicalSandboxId: SANDBOX_ID,
      physicalProviderRef: null,
      provider: 'cloudflare',
      configuration: null,
      physicalState: 'creating',
    });
  });

  it('reports a connected allocation as running by its provider reference', () => {
    expect(
      projectAllocationInspection(
        SANDBOX_ID,
        view({ kind: 'connected', allocationId: 'alloc-1', providerRef: 'provider-ref-9' })
      )
    ).toEqual({
      logicalSandboxId: SANDBOX_ID,
      physicalProviderRef: 'provider-ref-9',
      provider: 'cloudflare',
      configuration: null,
      physicalState: 'running',
    });
  });

  it('reports a stopping allocation with its provider reference', () => {
    expect(
      projectAllocationInspection(
        SANDBOX_ID,
        view({ kind: 'stopping', allocationId: 'alloc-1', providerRef: 'provider-ref-9' })
      )
    ).toEqual({
      logicalSandboxId: SANDBOX_ID,
      physicalProviderRef: 'provider-ref-9',
      provider: 'cloudflare',
      configuration: null,
      physicalState: 'stopping',
    });
  });

  it.each(['vercel', 'cloudflare-containers'] as const)(
    'reports the persisted %s provider next to the reference',
    provider => {
      expect(
        projectAllocationInspection(
          SANDBOX_ID,
          view({
            kind: 'connected',
            allocationId: 'alloc-1',
            providerRef: 'provider-ref-9',
            provider,
          })
        )
      ).toEqual({
        logicalSandboxId: SANDBOX_ID,
        physicalProviderRef: 'provider-ref-9',
        provider,
        configuration: null,
        physicalState: 'running',
      });
    }
  );

  it.each([
    { provider: 'vercel', resources: { vcpus: 2, memory: 4096 } },
    { provider: 'vercel', resources: { vcpus: 4, memory: 8192 } },
    { provider: 'cloudflare-containers', instance: 'standard-3' },
    { provider: 'cloudflare-containers', instance: 'standard-4' },
  ] as const)('reports the persisted configuration $provider', configuration => {
    expect(
      projectAllocationInspection(
        SANDBOX_ID,
        view({
          kind: 'connected',
          providerRef: 'provider-ref-9',
          provider: configuration.provider,
          configuration,
        })
      )
    ).toMatchObject({ configuration });
  });
});
