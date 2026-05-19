import { describe, it, expect } from 'vitest';
import { pickRigIdForWastelandBead } from './wasteland-bead.helpers';
import { readWastelandBeadOrigin } from '../dos/town/wasteland-bead-origin';

describe('pickRigIdForWastelandBead', () => {
  it('matches a local rig by name when rig_handle is the rig name', () => {
    const rigs = [
      { id: 'rig-a', name: 'kilo-org/cloud' },
      { id: 'rig-b', name: 'kilo-org/web' },
    ];
    expect(pickRigIdForWastelandBead(rigs, 'kilo-org/web')).toBe('rig-b');
  });

  it('falls back to the only rig when there is exactly one and no name match', () => {
    const rigs = [{ id: 'rig-only', name: 'something-else' }];
    expect(pickRigIdForWastelandBead(rigs, 'kilo-org/cloud')).toBe('rig-only');
  });

  it('returns null when there are multiple rigs and none match', () => {
    const rigs = [
      { id: 'rig-a', name: 'foo' },
      { id: 'rig-b', name: 'bar' },
    ];
    expect(pickRigIdForWastelandBead(rigs, 'baz')).toBeNull();
  });

  it('returns null when there are no rigs at all', () => {
    expect(pickRigIdForWastelandBead([], 'foo')).toBeNull();
  });
});

describe('readWastelandBeadOrigin', () => {
  it('returns null for missing or non-object metadata', () => {
    expect(readWastelandBeadOrigin(null)).toBeNull();
    expect(readWastelandBeadOrigin(undefined)).toBeNull();
    expect(readWastelandBeadOrigin({})).toBeNull();
    expect(readWastelandBeadOrigin({ wasteland: 'not-an-object' })).toBeNull();
  });

  it('returns null when the wasteland field has the wrong shape', () => {
    expect(readWastelandBeadOrigin({ wasteland: { kind: 'unknown' } })).toBeNull();
    expect(readWastelandBeadOrigin({ wasteland: { kind: 'wanted-item-claim' } })).toBeNull(); // missing ids
  });

  it('parses a well-formed origin', () => {
    const origin = readWastelandBeadOrigin({
      wasteland: {
        kind: 'wanted-item-claim',
        wasteland_id: 'w',
        item_id: 'i',
      },
    });
    expect(origin).toEqual({
      kind: 'wanted-item-claim',
      wasteland_id: 'w',
      item_id: 'i',
    });
  });
});
