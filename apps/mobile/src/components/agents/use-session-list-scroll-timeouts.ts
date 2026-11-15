import { type RefObject, useCallback, useEffect, useMemo, useRef } from 'react';

type Timeout = ReturnType<typeof setTimeout>;

/**
 * How long a released drag waits for its momentum end before the drag counts as
 * settled: `onMomentumScrollEnd` is not guaranteed for a short or slow drag.
 */
const DRAG_SETTLE_MS = 100;

/**
 * How long a fling may report nothing before its motion is considered over. A
 * momentum end can be dropped by the platform, and motion that never ends would
 * disable every scheduled resume scroll and tail follow for the rest of the
 * screen.
 */
export const MOMENTUM_BOUND_MS = 2000;

/**
 * What the scroller is doing with the user's finger or its fling.
 *
 * One value, not two flags: every state that outlives an event carries the
 * timer it owns, so a transition can cancel exactly what the previous state
 * armed, and a timer callback compares itself against the current state before
 * acting — a bound left over from one fling cannot settle the drag that began
 * after it.
 *
 * `settling` and `flinging` carry the claim settle they must run when they
 * expire, so ending the motion and settling the position it left are one
 * transition.
 */
export type MotionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'dragging' }
  | { readonly kind: 'settling'; readonly timer: Timeout; readonly settle: () => void }
  | { readonly kind: 'flinging'; readonly timer: Timeout; readonly settle: () => void };

const IDLE: MotionState = { kind: 'idle' };

/** True while the list is moving under the user: dragging or flinging. */
export function motionIsMoving(state: MotionState): boolean {
  return state.kind !== 'idle';
}

/** Cancels the timer a settling or flinging state owns. */
function clearMotionTimer(state: MotionState): void {
  if (state.kind === 'settling' || state.kind === 'flinging') {
    clearTimeout(state.timer);
  }
}

/**
 * One transcript scroller's timers and the motion state that owns them.
 *
 * The programmatic-scroll window and the follow retry belong together because
 * they outlive the callbacks that start them, and a scroller that goes away must
 * leave none of them firing. Motion lives here because it has one writer: every
 * event is a transition that clears what the previous state armed, and unmount
 * ends whatever is live.
 */
export function useSessionListScrollTimeouts() {
  const resetRef = useRef<Timeout | null>(null);
  const retryRef = useRef<Timeout | null>(null);
  const motionRef = useRef<MotionState>(IDLE);
  const clear = useCallback((ref: RefObject<Timeout | null>) => {
    const timeout = ref.current;
    if (timeout !== null) {
      clearTimeout(timeout);
      ref.current = null;
    }
  }, []);
  const clearReset = useCallback(() => {
    clear(resetRef);
  }, [clear, resetRef]);
  const clearRetry = useCallback(() => {
    clear(retryRef);
  }, [clear, retryRef]);

  /** Ends motion without settling anything: a reset, or an unmount. */
  const endMotion = useCallback(() => {
    clearMotionTimer(motionRef.current);
    motionRef.current = IDLE;
  }, [motionRef]);

  /** The user put a finger down: a new drag replaces whatever motion was live. */
  const beginDrag = useCallback(() => {
    clearMotionTimer(motionRef.current);
    motionRef.current = { kind: 'dragging' };
  }, [motionRef]);

  /** Arms `ms` of motion that settles itself, unless another transition ends it. */
  const armMotion = useCallback(
    (kind: 'settling' | 'flinging', ms: number, settle: () => void) => {
      clearMotionTimer(motionRef.current);
      let armed: MotionState = IDLE;
      const timer = setTimeout(() => {
        // A later event already replaced this state: its timer was cleared, and
        // this callback must not settle a claim that is no longer the one armed.
        if (motionRef.current !== armed) {
          return;
        }
        motionRef.current = IDLE;
        settle();
      }, ms);
      armed = { kind, timer, settle };
      motionRef.current = armed;
    },
    [motionRef]
  );

  /** The finger lifted: the drag settles itself unless a real fling begins. */
  const endDrag = useCallback(
    (settle: () => void) => {
      armMotion('settling', DRAG_SETTLE_MS, settle);
    },
    [armMotion]
  );

  /** A fling is running, and it may never report its end: one bound, not none. */
  const beginMomentum = useCallback(
    (settle: () => void) => {
      armMotion('flinging', MOMENTUM_BOUND_MS, settle);
    },
    [armMotion]
  );

  /** The fling reported its end: motion is over now, and the claim settles. */
  const endMomentum = useCallback(
    (settle: () => void) => {
      clearMotionTimer(motionRef.current);
      motionRef.current = IDLE;
      settle();
    },
    [motionRef]
  );

  useEffect(
    () => () => {
      clearReset();
      clearRetry();
      endMotion();
    },
    [clearReset, clearRetry, endMotion]
  );

  return useMemo(
    () => ({
      resetRef,
      retryRef,
      motionRef,
      clearReset,
      clearRetry,
      beginDrag,
      endDrag,
      beginMomentum,
      endMomentum,
      endMotion,
    }),
    [clearReset, clearRetry, beginDrag, endDrag, beginMomentum, endMomentum, endMotion, motionRef]
  );
}
