import { resumeAnchor } from './resume-anchor';

describe('resumeAnchor', () => {
  it('resolves the group that starts with the anchor', () => {
    expect(resumeAnchor([['m1'], ['m2'], ['m3']], 'm2')).toEqual({
      groupIndex: 1,
      selectorIds: ['m2', 'm3'],
    });
  });

  it('falls back to the group first id when the anchor is mid-group', () => {
    expect(resumeAnchor([['m1'], ['m2', 'm3'], ['m4']], 'm3')).toEqual({
      groupIndex: 1,
      selectorIds: ['m2', 'm4'],
    });
  });

  it('offers every later group so an unrendered group can be skipped', () => {
    // The anchor's own group can render no element at all (an all-invisible
    // assistant turn), so the caller needs the following groups' handles to
    // land on the nearest group that did render.
    expect(resumeAnchor([['m1'], ['m2'], ['m3'], ['m4']], 'm2')).toEqual({
      groupIndex: 1,
      selectorIds: ['m2', 'm3', 'm4'],
    });
  });

  it('skips an empty group without letting it shift the index', () => {
    expect(resumeAnchor([['m1'], [], ['m2']], 'm2')).toEqual({
      groupIndex: 2,
      selectorIds: ['m2'],
    });
  });

  it('returns null when the anchor is absent', () => {
    expect(resumeAnchor([['m1'], ['m2', 'm3']], 'm9')).toBeNull();
  });

  it('returns null for an empty transcript', () => {
    expect(resumeAnchor([], 'm1')).toBeNull();
  });

  it('returns null without an anchor id', () => {
    expect(resumeAnchor([['m1']], null)).toBeNull();
    expect(resumeAnchor([['m1']], undefined)).toBeNull();
    expect(resumeAnchor([['m1']], '')).toBeNull();
  });
});
