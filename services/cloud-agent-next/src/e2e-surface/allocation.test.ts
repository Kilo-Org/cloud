import { describe, expect, it } from 'vitest';
import { allocationFixture } from '../sandbox-state/model/allocation-fixtures.js';
import { projectAllocationInspection } from './allocation.js';

const SANDBOX_ID = 'usr-000000000abc';
const INTENT = { intentId: 'e2e-intent', createdAt: 1 };

function record(fixture: Parameters<typeof allocationFixture>[0]) {
  const built = allocationFixture(fixture);
  if (!built) throw new Error('unrepresentable fixture');
  return built;
}

describe('projectAllocationInspection', () => {
  it('reports nothing for an initial stopped record', () => {
    expect(projectAllocationInspection(SANDBOX_ID, record({ state: 'stopped' }))).toEqual({
      logicalSandboxId: SANDBOX_ID,
      physicalProviderRef: null,
      physicalState: null,
    });
  });

  it('reports creating before a provider reference exists', () => {
    expect(
      projectAllocationInspection(SANDBOX_ID, record({ state: 'creating', createIntent: INTENT }))
    ).toEqual({
      logicalSandboxId: SANDBOX_ID,
      physicalProviderRef: null,
      physicalState: 'creating',
    });
  });

  it('reports a running allocation by its provider reference', () => {
    expect(
      projectAllocationInspection(
        SANDBOX_ID,
        record({ state: 'running', providerRef: 'provider-ref-9', createIntent: INTENT })
      )
    ).toEqual({
      logicalSandboxId: SANDBOX_ID,
      physicalProviderRef: 'provider-ref-9',
      physicalState: 'running',
    });
  });
});
