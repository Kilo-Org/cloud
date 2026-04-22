/**
 * Unit tests for convoyAddBead validation rules.
 *
 * These test the guard conditions from Town.do.ts::convoyAddBead.
 * Integration tests for the happy path (bead held during staged, dispatched
 * after start) live in test/integration/convoy-dag.test.ts.
 *
 * DO exceptions corrupt vitest-pool-workers isolated storage, so rejection
 * tests must live here as pure unit tests.
 */
import { describe, it, expect } from 'vitest';

type ConvoyStatus = 'active' | 'landed';

type ConvoyEntry = {
  id: string;
  staged: boolean;
  status: ConvoyStatus;
};

/**
 * Pure reimplementation of the convoyAddBead validation from Town.do.ts.
 * Kept in sync with:
 *   Town.do.ts::convoyAddBead (lines ~1220-1223)
 */
function validateConvoyAddBead(convoy: ConvoyEntry | null): void {
  if (!convoy) throw new Error(`Bead is not a convoy`);
  if (!convoy.staged) throw new Error(`Cannot add beads to a non-staged convoy: ${convoy.id}`);
  if (convoy.status === 'landed') throw new Error(`Cannot add beads to a closed convoy: ${convoy.id}`);
}

describe('convoyAddBead validation', () => {
  it('allows adding to a staged active convoy', () => {
    expect(() =>
      validateConvoyAddBead({ id: 'convoy-1', staged: true, status: 'active' })
    ).not.toThrow();
  });

  it('rejects null convoy (not found)', () => {
    expect(() => validateConvoyAddBead(null)).toThrow(/not a convoy/);
  });

  it('rejects non-staged (active) convoy', () => {
    expect(() =>
      validateConvoyAddBead({ id: 'convoy-1', staged: false, status: 'active' })
    ).toThrow(/non-staged/);
  });

  it('rejects staged but landed convoy', () => {
    // Landed convoys have staged=false in practice, but guard against status too
    expect(() =>
      validateConvoyAddBead({ id: 'convoy-1', staged: true, status: 'landed' })
    ).toThrow(/closed/);
  });

  it('rejects non-staged landed convoy', () => {
    expect(() =>
      validateConvoyAddBead({ id: 'convoy-1', staged: false, status: 'landed' })
    ).toThrow(/non-staged/);
  });
});
