import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MOMENTUM_BOUND_MS,
  motionIsMoving,
  type MotionState,
  useSessionListScrollTimeouts,
} from './use-session-list-scroll-timeouts';

type Timers = ReturnType<typeof useSessionListScrollTimeouts>;

const renderers: TestRenderer.ReactTestRenderer[] = [];

/** Mounts the hook and hands back a live read of what it returns. */
function mountTimers(): () => Timers {
  const probe: { current: Timers | null } = { current: null };
  function Probe() {
    probe.current = useSessionListScrollTimeouts();
    return createElement('View', null);
  }
  const created: { current?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    created.current = TestRenderer.create(createElement(Probe));
  });
  const renderer = created.current;
  if (renderer === undefined) {
    throw new Error('renderer was not created');
  }
  renderers.push(renderer);
  return () => {
    const timers = probe.current;
    if (timers === null) {
      throw new Error('the timers hook did not mount');
    }
    return timers;
  };
}

type Event = 'beginDrag' | 'endDrag' | 'beginMomentum' | 'endMomentum' | 'endMotion';

/** Puts the hook in one state, tracking the settle that state owns. */
function arrive(
  timers: Timers,
  state: 'idle' | 'dragging' | 'settling' | 'flinging'
): () => number {
  const seen = { settles: 0 };
  const settle = () => {
    seen.settles += 1;
  };
  if (state !== 'idle') {
    timers.beginDrag();
  }
  if (state === 'settling') {
    timers.endDrag(settle);
  }
  if (state === 'flinging') {
    timers.beginMomentum(settle);
  }
  // The settle a state runs while it is being entered is not a stale fire.
  seen.settles = 0;
  return () => seen.settles;
}

function fire(timers: Timers, event: Event, settle: () => void): void {
  if (event === 'beginDrag') {
    timers.beginDrag();
  } else if (event === 'endDrag') {
    timers.endDrag(settle);
  } else if (event === 'beginMomentum') {
    timers.beginMomentum(settle);
  } else if (event === 'endMomentum') {
    timers.endMomentum(settle);
  } else {
    timers.endMotion();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const renderer of renderers.splice(0)) {
    renderer.unmount();
  }
  vi.useRealTimers();
});

describe('motion transitions', () => {
  /*
   * Every event from every state. `moving` is what the list reports right after
   * the event, and `settledNow` is whether the event settled the claim at once.
   * The stale check is separate and applies to every row: the timer the arrival
   * state owned must never fire after another event replaced it.
   */
  const TABLE: readonly {
    readonly from: 'idle' | 'dragging' | 'settling' | 'flinging';
    readonly event: Event;
    readonly moving: boolean;
    readonly settledNow: boolean;
  }[] = [
    { from: 'idle', event: 'beginDrag', moving: true, settledNow: false },
    { from: 'idle', event: 'endDrag', moving: true, settledNow: false },
    { from: 'idle', event: 'beginMomentum', moving: true, settledNow: false },
    { from: 'idle', event: 'endMomentum', moving: false, settledNow: true },
    { from: 'idle', event: 'endMotion', moving: false, settledNow: false },

    { from: 'dragging', event: 'beginDrag', moving: true, settledNow: false },
    { from: 'dragging', event: 'endDrag', moving: true, settledNow: false },
    { from: 'dragging', event: 'beginMomentum', moving: true, settledNow: false },
    { from: 'dragging', event: 'endMomentum', moving: false, settledNow: true },
    { from: 'dragging', event: 'endMotion', moving: false, settledNow: false },

    { from: 'settling', event: 'beginDrag', moving: true, settledNow: false },
    { from: 'settling', event: 'endDrag', moving: true, settledNow: false },
    { from: 'settling', event: 'beginMomentum', moving: true, settledNow: false },
    { from: 'settling', event: 'endMomentum', moving: false, settledNow: true },
    { from: 'settling', event: 'endMotion', moving: false, settledNow: false },

    { from: 'flinging', event: 'beginDrag', moving: true, settledNow: false },
    { from: 'flinging', event: 'endDrag', moving: true, settledNow: false },
    { from: 'flinging', event: 'beginMomentum', moving: true, settledNow: false },
    { from: 'flinging', event: 'endMomentum', moving: false, settledNow: true },
    { from: 'flinging', event: 'endMotion', moving: false, settledNow: false },
  ];

  for (const row of TABLE) {
    it(`${row.from} + ${row.event}`, () => {
      const api = mountTimers();
      const timers = api();
      const staleSettles = arrive(timers, row.from);
      let settledNow = 0;

      fire(timers, row.event, () => {
        settledNow += 1;
      });

      expect(motionIsMoving(timers.motionRef.current)).toBe(row.moving);
      expect(settledNow > 0).toBe(row.settledNow);

      // The timer the arrival state armed belonged to that state: once another
      // event replaced it, it must never settle the claim now in force.
      act(() => {
        vi.advanceTimersByTime(MOMENTUM_BOUND_MS + 1);
      });
      expect(staleSettles()).toBe(0);
    });
  }

  /* A state that arms a timer settles its own claim exactly once when it fires. */
  const EXPIRY: readonly {
    readonly from: 'idle' | 'dragging' | 'settling' | 'flinging';
    readonly moving: boolean;
    readonly settles: boolean;
  }[] = [
    { from: 'idle', moving: false, settles: false },
    { from: 'dragging', moving: true, settles: false },
    { from: 'settling', moving: false, settles: true },
    { from: 'flinging', moving: false, settles: true },
  ];

  for (const row of EXPIRY) {
    it(`${row.from} expires on its own`, () => {
      const api = mountTimers();
      const timers = api();
      const settles = arrive(timers, row.from);

      act(() => {
        vi.advanceTimersByTime(MOMENTUM_BOUND_MS + 1);
      });

      expect(motionIsMoving(timers.motionRef.current)).toBe(row.moving);
      expect(settles()).toBe(row.settles ? 1 : 0);
    });
  }

  it('reads idle as still and every other state as moving', () => {
    const states: readonly [MotionState, boolean][] = [
      [{ kind: 'idle' }, false],
      [{ kind: 'dragging' }, true],
      [{ kind: 'settling', timer: 0 as never, settle: () => undefined }, true],
      [{ kind: 'flinging', timer: 0 as never, settle: () => undefined }, true],
    ];
    for (const [state, moving] of states) {
      expect(motionIsMoving(state)).toBe(moving);
    }
  });
});
