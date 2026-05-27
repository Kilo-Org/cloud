import { describe, it, expect } from '@jest/globals';
import { buildRelatedBeads, type BeadLike } from './BeadPanel';

const makeBead = (overrides: Partial<BeadLike> & Pick<BeadLike, 'bead_id'>): BeadLike => ({
  type: 'merge_request',
  status: 'in_progress',
  title: 'Test bead',
  parent_bead_id: null,
  labels: [],
  metadata: {},
  ...overrides,
});

describe('buildRelatedBeads', () => {
  it('includes Source Work link for non-babysit merge_request bead with source_bead_id', () => {
    const sourceBead = makeBead({ bead_id: 'source-1', type: 'issue' });
    const mrBead = makeBead({
      bead_id: 'mr-1',
      type: 'merge_request',
      metadata: { source_bead_id: 'source-1' },
    });

    const related = buildRelatedBeads(mrBead, [sourceBead, mrBead], []);
    const sourceLink = related.find(r => r.relation === 'source');
    expect(sourceLink).toBeDefined();
    expect(sourceLink?.label).toBe('Source Work');
  });

  it('omits Source Work link for babysit bead even if source_bead_id is present', () => {
    const sourceBead = makeBead({ bead_id: 'source-1', type: 'issue' });
    const babysitBead = makeBead({
      bead_id: 'mr-1',
      type: 'merge_request',
      labels: ['gt:babysit'],
      metadata: { source_bead_id: 'source-1' },
    });

    const related = buildRelatedBeads(babysitBead, [sourceBead, babysitBead], []);
    const sourceLink = related.find(r => r.relation === 'source');
    expect(sourceLink).toBeUndefined();
  });

  it('omits Source Work link for babysit bead with no source_bead_id', () => {
    const babysitBead = makeBead({
      bead_id: 'mr-1',
      type: 'merge_request',
      labels: ['gt:babysit'],
      metadata: {},
    });

    const related = buildRelatedBeads(babysitBead, [babysitBead], []);
    const sourceLink = related.find(r => r.relation === 'source');
    expect(sourceLink).toBeUndefined();
  });

  it('still shows child beads for babysit MR beads', () => {
    const babysitBead = makeBead({
      bead_id: 'mr-1',
      type: 'merge_request',
      labels: ['gt:babysit'],
      metadata: {},
    });
    const childBead = makeBead({
      bead_id: 'child-1',
      type: 'issue',
      parent_bead_id: 'mr-1',
    });

    const related = buildRelatedBeads(babysitBead, [babysitBead, childBead], []);
    const childLink = related.find(r => r.relation === 'child');
    expect(childLink).toBeDefined();
  });
});
