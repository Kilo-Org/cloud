import { describe, it, expect } from 'vitest';
import {
  buildEvidence,
  computeClaimStatus,
  groupBeadsByWastelandClaim,
  isAlreadyReported,
  pickCanonicalBead,
  type ReporterBead,
  type ReporterClaim,
} from './wasteland-reporter';

const WL = 'wl-1';
const ITEM = 'item-7';

const wastelandTag = (overrides: Record<string, unknown> = {}) => ({
  wasteland: {
    kind: 'wanted-item-claim',
    wasteland_id: WL,
    item_id: ITEM,
    ...overrides,
  },
});

const bead = (overrides: Partial<ReporterBead>): ReporterBead => ({
  bead_id: overrides.bead_id ?? `b-${Math.random()}`,
  type: 'issue',
  status: 'open',
  title: 'Untitled',
  metadata: wastelandTag(),
  pr_url: null,
  created_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

describe('groupBeadsByWastelandClaim', () => {
  it('skips beads with no wasteland origin', () => {
    const claims = groupBeadsByWastelandClaim([
      bead({ metadata: {} }),
      bead({ metadata: { wasteland: { kind: 'unknown' } } }),
    ]);
    expect(claims).toEqual([]);
  });

  it('groups all beads with the same item_id into one claim', () => {
    const claims = groupBeadsByWastelandClaim([
      bead({ bead_id: 'a', type: 'convoy', created_at: '2026-01-01T00:00:00Z' }),
      bead({ bead_id: 'b', type: 'issue', created_at: '2026-01-02T00:00:00Z' }),
      bead({ bead_id: 'c', type: 'merge_request', created_at: '2026-01-03T00:00:00Z' }),
    ]);
    expect(claims).toHaveLength(1);
    expect(claims[0].wasteland_id).toBe(WL);
    expect(claims[0].item_id).toBe(ITEM);
    expect(claims[0].beads.map(b => b.bead_id)).toEqual(['a', 'b', 'c']);
  });

  it('separates claims by wasteland_id and item_id', () => {
    const claims = groupBeadsByWastelandClaim([
      bead({ bead_id: 'a' }),
      bead({ bead_id: 'b', metadata: wastelandTag({ item_id: 'other' }) }),
      bead({ bead_id: 'c', metadata: wastelandTag({ wasteland_id: 'wl-2' }) }),
    ]);
    expect(claims).toHaveLength(3);
  });
});

describe('pickCanonicalBead', () => {
  it('returns null for empty input', () => {
    expect(pickCanonicalBead([])).toBeNull();
  });

  it('picks the convoy bead when present', () => {
    const a = bead({ bead_id: 'a', type: 'issue', created_at: '2026-01-01T00:00:00Z' });
    const b = bead({ bead_id: 'b', type: 'convoy', created_at: '2026-01-02T00:00:00Z' });
    expect(pickCanonicalBead([a, b])?.bead_id).toBe('b');
  });

  it('falls back to the first bead by created_at when no convoy bead exists', () => {
    const a = bead({ bead_id: 'a', type: 'issue', created_at: '2026-01-01T00:00:00Z' });
    const b = bead({ bead_id: 'b', type: 'issue', created_at: '2026-01-02T00:00:00Z' });
    // groupBeadsByWastelandClaim already sorts; pickCanonicalBead trusts that.
    expect(pickCanonicalBead([a, b])?.bead_id).toBe('a');
  });
});

describe('computeClaimStatus', () => {
  const buildClaim = (beads: ReporterBead[]): ReporterClaim => {
    const claims = groupBeadsByWastelandClaim(beads);
    return claims[0];
  };

  it('returns in-flight when no merge_request bead exists', () => {
    const claim = buildClaim([bead({ bead_id: 'a', type: 'issue', status: 'open' })]);
    expect(computeClaimStatus(claim)).toEqual({ kind: 'in-flight' });
  });

  it('returns in-flight when an MR bead is still open', () => {
    const claim = buildClaim([
      bead({ bead_id: 'a', type: 'issue', status: 'closed' }),
      bead({ bead_id: 'b', type: 'merge_request', status: 'in_progress' }),
    ]);
    expect(computeClaimStatus(claim)).toEqual({ kind: 'in-flight' });
  });

  it('returns failed when every MR is failed and none merged', () => {
    const claim = buildClaim([
      bead({ bead_id: 'a', type: 'merge_request', status: 'failed' }),
      bead({ bead_id: 'b', type: 'merge_request', status: 'failed' }),
    ]);
    expect(computeClaimStatus(claim)).toEqual({ kind: 'failed' });
  });

  it('returns merged with PR URLs when all MRs are closed (single-bead claim)', () => {
    const claim = buildClaim([
      bead({
        bead_id: 'mr',
        type: 'merge_request',
        status: 'closed',
        title: 'Fix bug',
        pr_url: 'https://github.com/o/r/pull/1',
      }),
    ]);
    const status = computeClaimStatus(claim);
    expect(status.kind).toBe('merged');
    if (status.kind === 'merged') {
      expect(status.merged_pr_urls).toEqual([
        { url: 'https://github.com/o/r/pull/1', title: 'Fix bug' },
      ]);
    }
  });

  it('strict-all: in-flight when one MR merged but another still open', () => {
    const claim = buildClaim([
      bead({
        bead_id: 'mr1',
        type: 'merge_request',
        status: 'closed',
        pr_url: 'https://github.com/o/r/pull/1',
      }),
      bead({ bead_id: 'mr2', type: 'merge_request', status: 'in_progress' }),
    ]);
    expect(computeClaimStatus(claim).kind).toBe('in-flight');
  });

  it('strict-all: merged when MRs partly merged + partly failed (still terminal, ≥1 merged)', () => {
    const claim = buildClaim([
      bead({
        bead_id: 'mr1',
        type: 'merge_request',
        status: 'closed',
        pr_url: 'https://github.com/o/r/pull/1',
      }),
      bead({ bead_id: 'mr2', type: 'merge_request', status: 'failed' }),
    ]);
    const status = computeClaimStatus(claim);
    expect(status.kind).toBe('merged');
  });

  it('convoy gating: in-flight when MRs closed but convoy still open', () => {
    const claim = buildClaim([
      bead({ bead_id: 'cv', type: 'convoy', status: 'open' }),
      bead({
        bead_id: 'mr',
        type: 'merge_request',
        status: 'closed',
        pr_url: 'https://github.com/o/r/pull/1',
      }),
    ]);
    expect(computeClaimStatus(claim).kind).toBe('in-flight');
  });

  it('convoy gating: merged when convoy is also closed', () => {
    const claim = buildClaim([
      bead({ bead_id: 'cv', type: 'convoy', status: 'closed' }),
      bead({
        bead_id: 'mr',
        type: 'merge_request',
        status: 'closed',
        pr_url: 'https://github.com/o/r/pull/1',
      }),
    ]);
    expect(computeClaimStatus(claim).kind).toBe('merged');
  });

  it('deduplicates PR URLs in evidence', () => {
    const claim = buildClaim([
      bead({
        bead_id: 'mr1',
        type: 'merge_request',
        status: 'closed',
        title: 'A',
        pr_url: 'https://x/pr/1',
      }),
      bead({
        bead_id: 'mr2',
        type: 'merge_request',
        status: 'closed',
        title: 'B',
        pr_url: 'https://x/pr/1',
      }),
    ]);
    const status = computeClaimStatus(claim);
    if (status.kind === 'merged') {
      expect(status.merged_pr_urls).toHaveLength(1);
    } else {
      throw new Error('expected merged');
    }
  });
});

describe('buildEvidence', () => {
  it('formats a single PR as an inline sentence', () => {
    const evidence = buildEvidence(
      { kind: 'merged', merged_pr_urls: [{ url: 'https://x/pr/1', title: 'Fix bug' }] },
      'fallback'
    );
    expect(evidence).toBe('Implemented by https://x/pr/1 (Fix bug).');
  });

  it('formats multiple PRs as a markdown list', () => {
    const evidence = buildEvidence(
      {
        kind: 'merged',
        merged_pr_urls: [
          { url: 'https://x/pr/1', title: 'A' },
          { url: 'https://x/pr/2', title: 'B' },
        ],
      },
      'fallback'
    );
    expect(evidence).toBe('Implemented by:\n- https://x/pr/1 (A)\n- https://x/pr/2 (B)');
  });

  it('falls back when no PR URLs are available', () => {
    const evidence = buildEvidence(
      { kind: 'merged', merged_pr_urls: [] },
      'Wasteland claim: item-7'
    );
    expect(evidence).toContain('Wasteland claim: item-7');
  });
});

describe('isAlreadyReported', () => {
  it('returns false when no reported_done_at is set', () => {
    const claim = groupBeadsByWastelandClaim([bead({ bead_id: 'a' })])[0];
    expect(isAlreadyReported(claim)).toBe(false);
  });

  it('returns true when reported_done_at is a non-empty string', () => {
    const claim = groupBeadsByWastelandClaim([
      bead({
        bead_id: 'a',
        metadata: wastelandTag({ reported_done_at: '2026-05-11T20:00:00Z' }),
      }),
    ])[0];
    expect(isAlreadyReported(claim)).toBe(true);
  });
});
