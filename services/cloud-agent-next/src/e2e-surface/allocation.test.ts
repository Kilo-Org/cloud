import { describe, expect, it } from 'vitest';
import {
  initialAllocationState,
  type AllocationView,
} from '../control-plane/sandbox/allocation.js';
import { projectAllocationInspection } from './allocation.js';

const SANDBOX_ID = 'usr-000000000abc';

function view(overrides: Partial<AllocationView>): AllocationView {
  return { ...initialAllocationState(), provider: 'cloudflare', ...overrides };
}

describe('projectAllocationInspection', () => {
  it('reports nothing for a session that never owned an allocation', () => {
    expect(projectAllocationInspection(SANDBOX_ID, view({}))).toEqual({
      logicalSandboxId: SANDBOX_ID,
      physicalProviderRef: null,
      physicalState: null,
    });
  });

  it('reports a stopped allocation without a live provider reference', () => {
    expect(
      projectAllocationInspection(SANDBOX_ID, view({ allocationId: 'alloc-1', kind: 'stopped' }))
    ).toEqual({
      logicalSandboxId: SANDBOX_ID,
      physicalProviderRef: null,
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
      physicalState: 'unknown',
    });
  });

  it('reports creating before a provider reference exists', () => {
    expect(
      projectAllocationInspection(SANDBOX_ID, view({ kind: 'starting', allocationId: 'alloc-1' }))
    ).toEqual({
      logicalSandboxId: SANDBOX_ID,
      physicalProviderRef: null,
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
      physicalState: 'stopping',
    });
  });
});
