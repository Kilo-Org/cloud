import { getTodoPresentation } from './tool-todos';

const pending = { content: 'Pending task', status: 'pending', priority: 'medium' };
const completed = { content: 'Finished task', status: 'completed', priority: 'low' };
const active = { content: 'Active task', status: 'in_progress', priority: 'high' };
const cancelled = { content: 'Cancelled task', status: 'cancelled', priority: 'low' };

describe('getTodoPresentation', () => {
  it('uses the compact metadata view without deriving progress from the visible subset', () => {
    const changed = { ...active, changed: true };
    expect(
      getTodoPresentation([pending], {
        todos: [completed, active, pending, cancelled],
        view: { mode: 'compact', todos: [changed], hiddenBefore: 1, hiddenAfter: 2 },
      })
    ).toEqual({
      shown: [changed],
      completed: 1,
      total: 4,
      hiddenBefore: 1,
      hiddenAfter: 2,
    });
  });

  it('prefers metadata todos over stale input when no view is supplied', () => {
    expect(getTodoPresentation([pending], { todos: [completed] })).toEqual({
      shown: [completed],
      completed: 1,
      total: 1,
      hiddenBefore: 0,
      hiddenAfter: 0,
    });
  });

  it('uses input todos when metadata has no todo array', () => {
    expect(getTodoPresentation([pending, cancelled], { todos: 'invalid', view: {} })).toEqual({
      shown: [pending, cancelled],
      completed: 0,
      total: 2,
      hiddenBefore: 0,
      hiddenAfter: 0,
    });
  });

  it('respects explicitly empty metadata and view lists', () => {
    expect(getTodoPresentation([pending], { todos: [] })).toMatchObject({ shown: [], total: 0 });
    expect(getTodoPresentation([pending], { view: { mode: 'compact', todos: [] } })).toMatchObject({
      shown: [],
      total: 1,
    });
  });

  it('does not display hidden counts outside compact mode', () => {
    expect(
      getTodoPresentation([pending], {
        view: { mode: 'full', todos: [pending], hiddenBefore: 3, hiddenAfter: 4 },
      })
    ).toMatchObject({ shown: [pending], hiddenBefore: 0, hiddenAfter: 0 });
  });

  it('ignores invalid counts without revealing todos outside the supplied view', () => {
    expect(
      getTodoPresentation([pending, active, cancelled], {
        view: { mode: 'compact', todos: [active], hiddenBefore: -1, hiddenAfter: '2' },
      })
    ).toMatchObject({ shown: [active], hiddenBefore: 0, hiddenAfter: 0 });
  });

  it('retains valid statuses and high priority without requiring synthetic ids', () => {
    expect(getTodoPresentation([pending, active, completed, cancelled]).shown).toEqual([
      pending,
      active,
      completed,
      cancelled,
    ]);
  });

  it('skips malformed entries without discarding valid neighboring todos', () => {
    expect(
      getTodoPresentation([
        null,
        { content: { unsafe: true }, status: 'pending' },
        { content: 'Unknown status', status: 'unknown' },
        active,
      ])
    ).toMatchObject({ shown: [active], total: 1 });
  });

  it.each([undefined, null, {}, 'invalid', []])('handles empty or invalid input: %j', input => {
    expect(getTodoPresentation(input)).toEqual({
      shown: [],
      completed: 0,
      total: 0,
      hiddenBefore: 0,
      hiddenAfter: 0,
    });
  });
});
