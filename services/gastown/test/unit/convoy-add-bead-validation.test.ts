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
type BeadStatus = 'open' | 'in_progress' | 'in_review' | 'closed' | 'failed';

type ConvoyEntry = {
  id: string;
  staged: boolean;
  status: ConvoyStatus;
};

/**
 * Pure reimplementation of the convoyAddBead validation from Town.do.ts.
 * Kept in sync with:
 *   Town.do.ts::convoyAddBead (lines ~1220-1225)
 *
 * The rawStatus parameter mirrors convoyRecord.status (the actual bead status
 * before mapping to ConvoyEntry.status). This is needed because toConvoy()
 * collapses 'failed' → 'active', so the ConvoyEntry.status check alone would
 * not block failed convoys.
 */
function validateConvoyAddBead(convoy: ConvoyEntry | null, rawStatus?: BeadStatus): void {
  if (!convoy) throw new Error(`Bead is not a convoy`);
  if (!convoy.staged) throw new Error(`Cannot add beads to a non-staged convoy: ${convoy.id}`);
  if (convoy.status === 'landed')
    throw new Error(`Cannot add beads to a closed convoy: ${convoy.id}`);
  if (rawStatus === 'failed') throw new Error(`Cannot add beads to a failed convoy: ${convoy.id}`);
}

describe('convoyAddBead validation', () => {
  it('allows adding to a staged active convoy', () => {
    expect(() =>
      validateConvoyAddBead({ id: 'convoy-1', staged: true, status: 'active' }, 'in_progress')
    ).not.toThrow();
  });

  it('rejects null convoy (not found)', () => {
    expect(() => validateConvoyAddBead(null)).toThrow(/not a convoy/);
  });

  it('rejects non-staged (active) convoy', () => {
    expect(() =>
      validateConvoyAddBead({ id: 'convoy-1', staged: false, status: 'active' }, 'open')
    ).toThrow(/non-staged/);
  });

  it('rejects staged but landed convoy', () => {
    // Landed convoys have staged=false in practice, but guard against status too
    expect(() =>
      validateConvoyAddBead({ id: 'convoy-1', staged: true, status: 'landed' }, 'closed')
    ).toThrow(/closed/);
  });

  it('rejects non-staged landed convoy', () => {
    expect(() =>
      validateConvoyAddBead({ id: 'convoy-1', staged: false, status: 'landed' }, 'closed')
    ).toThrow(/non-staged/);
  });

  it('rejects failed convoy (toConvoy maps failed → active, raw check required)', () => {
    // toConvoy() maps 'failed' bead status to ConvoyEntry.status='active',
    // so without a raw status check the guard would pass a failed convoy.
    expect(() =>
      validateConvoyAddBead({ id: 'convoy-1', staged: true, status: 'active' }, 'failed')
    ).toThrow(/failed convoy/);
  });
});
