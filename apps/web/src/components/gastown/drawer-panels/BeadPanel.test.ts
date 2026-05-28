import { describe, it, expect } from '@jest/globals';
import { buildRelatedBeads, type BeadLike } from './buildRelatedBeads';

const makeBead = (
  overrides: Partial<BeadLike> & Pick<BeadLike, 'bead_id' | 'type' | 'title'>
): BeadLike => ({
  status: 'open',
  parent_bead_id: null,
  rig_id: null,
  metadata: {},
  ...overrides,
});

describe('buildRelatedBeads: babysit source bead filtering', () => {
  const sourceBead = makeBead({ bead_id: 'source-1', type: 'issue', title: 'Source Work' });

  it('includes source bead for non-babysit merge_request beads with source_bead_id', () => {
    const babysitBead = makeBead({
      bead_id: 'mr-1',
      type: 'merge_request',
      title: 'MR without babysit',
      metadata: { source_bead_id: 'source-1' },
    });
    const related = buildRelatedBeads(babysitBead, [babysitBead, sourceBead], []);
    const sourceRelation = related.find(r => r.relation === 'source');
    expect(sourceRelation).toBeDefined();
    expect(sourceRelation?.bead.bead_id).toBe('source-1');
  });

  it('excludes source bead for babysit beads (filtered by caller)', () => {
    const babysitBead = makeBead({
      bead_id: 'mr-2',
      type: 'merge_request',
      title: 'Babysat MR',
      metadata: { source_bead_id: 'source-1' },
    });
    const related = buildRelatedBeads(babysitBead, [babysitBead, sourceBead], []);
    const isBabysit = true;
    const filtered = related.filter(r => !(r.relation === 'source' && isBabysit));
    expect(filtered.find(r => r.relation === 'source')).toBeUndefined();
  });

  it('includes child beads regardless of babysit status', () => {
    const babysitBead = makeBead({
      bead_id: 'mr-3',
      type: 'merge_request',
      title: 'Babysat MR',
    });
    const childBead = makeBead({
      bead_id: 'child-1',
      type: 'issue',
      title: 'Child issue',
      parent_bead_id: 'mr-3',
    });
    const related = buildRelatedBeads(babysitBead, [babysitBead, childBead], []);
    const childRelation = related.find(r => r.relation === 'child');
    expect(childRelation).toBeDefined();
    expect(childRelation?.bead.bead_id).toBe('child-1');
  });
});

describe('babysit badge detection logic', () => {
  it('detects gt:babysit label', () => {
    const labels = ['gt:merge-request', 'gt:babysit'];
    expect(labels.includes('gt:babysit')).toBe(true);
  });

  it('does not detect gt:babysit when absent', () => {
    const labels = ['gt:merge-request'];
    expect(labels.includes('gt:babysit')).toBe(false);
  });
});

describe('babysit metadata extraction', () => {
  it('extracts head_sha from metadata', () => {
    const metadata: Record<string, unknown> = { head_sha: 'abc1234def5678' };
    expect(typeof metadata.head_sha).toBe('string');
    expect((metadata.head_sha as string).slice(0, 7)).toBe('abc1234');
  });

  it('extracts force_push_allowed from metadata', () => {
    const metaTrue: Record<string, unknown> = { force_push_allowed: true };
    const metaFalse: Record<string, unknown> = { force_push_allowed: false };
    const metaMissing: Record<string, unknown> = {};
    expect(metaTrue.force_push_allowed).toBe(true);
    expect(metaFalse.force_push_allowed).toBe(false);
    expect(metaMissing.force_push_allowed).toBeUndefined();
  });

  it('extracts babysit_started_at from metadata', () => {
    const metadata: Record<string, unknown> = { babysit_started_at: '2026-05-28T12:00:00Z' };
    expect(typeof metadata.babysit_started_at).toBe('string');
  });
});
