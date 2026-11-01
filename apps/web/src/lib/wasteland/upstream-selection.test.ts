import { selectUpstreamWasteland, type UpstreamAnswer } from './upstream-selection';

function wasteland(overrides: Partial<UpstreamAnswer> = {}): UpstreamAnswer {
  return {
    wastelandId: 'wl-a',
    ownerType: 'user',
    ownerUserId: 'user-1',
    organizationId: null,
    name: 'commons',
    ...overrides,
  };
}

describe('selectUpstreamWasteland', () => {
  it('opens the identity when the worker answers without candidates', () => {
    // A worker deployed before one address could reach several
    // wastelands answers only this shape; the shell has to render it.
    expect(selectUpstreamWasteland(wasteland(), null)).toEqual({
      kind: 'open',
      wasteland: wasteland(),
    });
  });

  it('ignores a selection the old answer cannot have offered', () => {
    expect(selectUpstreamWasteland(wasteland(), 'wl-a')).toEqual({
      kind: 'open',
      wasteland: wasteland(),
    });
  });

  it('asks the caller to choose when several wastelands are open to them', () => {
    const answer = wasteland({
      candidates: [wasteland(), wasteland({ wastelandId: 'wl-b', name: 'second' })],
    });

    expect(selectUpstreamWasteland(answer, null)).toEqual({
      kind: 'choose',
      candidates: answer.candidates,
    });
  });

  it('opens the candidate the address selects', () => {
    const second = wasteland({ wastelandId: 'wl-b', name: 'second' });
    const answer = wasteland({ candidates: [wasteland(), second] });

    expect(selectUpstreamWasteland(answer, 'wl-b')).toEqual({ kind: 'open', wasteland: second });
  });

  it('falls back to the chooser when the selection is not one of the candidates', () => {
    const answer = wasteland({ candidates: [wasteland(), wasteland({ wastelandId: 'wl-b' })] });

    expect(selectUpstreamWasteland(answer, 'wl-other')).toEqual({
      kind: 'choose',
      candidates: answer.candidates,
    });
  });

  it('selects only a candidate the answer lists', () => {
    // The flat identity is not what the address selects: only a listed
    // candidate can be opened from it.
    const answer = wasteland({ candidates: [wasteland({ wastelandId: 'wl-b' })] });

    expect(selectUpstreamWasteland(answer, 'wl-a').kind).toBe('choose');
  });
});
