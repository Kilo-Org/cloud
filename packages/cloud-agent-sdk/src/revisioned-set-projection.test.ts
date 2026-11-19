import { createRevisionedSetProjection } from './revisioned-set-projection';

describe('createRevisionedSetProjection', () => {
  const empty: ReadonlySet<string> = new Set();

  it('returns the shared empty set while no session is active', () => {
    const project = createRevisionedSetProjection<string>(() => new Set(['a']), empty);
    expect(project(null, 0)).toBe(empty);
  });

  it('returns the shared empty set for a session with no record', () => {
    const project = createRevisionedSetProjection<string>(() => undefined, empty);
    expect(project('ses-1', 0)).toBe(empty);
  });

  it('returns the shared empty set for an empty record', () => {
    const project = createRevisionedSetProjection<string>(() => new Set(), empty);
    expect(project('ses-1', 0)).toBe(empty);
  });

  it('keeps one identity between bumps and a new one per revision', () => {
    const records = new Map([['ses-1', new Set(['a'])]]);
    const project = createRevisionedSetProjection<string>(id => records.get(id), empty);
    const first = project('ses-1', 3);
    expect([...first]).toEqual(['a']);
    expect(project('ses-1', 3)).toBe(first);

    records.get('ses-1')?.add('b');
    const bumped = project('ses-1', 4);
    expect(bumped).not.toBe(first);
    expect([...bumped]).toEqual(['a', 'b']);
    expect(project('ses-1', 4)).toBe(bumped);
  });

  it('re-derives on a session switch even at the same revision', () => {
    const records = new Map([
      ['ses-1', new Set(['a'])],
      ['ses-2', new Set(['b'])],
    ]);
    const project = createRevisionedSetProjection<string>(id => records.get(id), empty);
    expect([...project('ses-1', 0)]).toEqual(['a']);
    expect([...project('ses-2', 0)]).toEqual(['b']);
  });

  it('reads a record that did not exist when the projection was created', () => {
    const records = new Map<string, Set<string>>();
    const project = createRevisionedSetProjection<string>(id => records.get(id), empty);
    expect(project('ses-1', 0)).toBe(empty);
    records.set('ses-1', new Set(['a']));
    expect([...project('ses-1', 1)]).toEqual(['a']);
  });
});
