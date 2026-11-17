import { usePreventRemove } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/dialog';
import { isLeaveAction } from '@/lib/navigation/leave-actions';
import { clearAcceptedBack } from '@/lib/navigation/leave-settle';

export type MetadataLeaveGuard = Readonly<{
  /** Wire this to the metadata form's `onDirtyChange`. */
  handleDirtyChange: (dirty: boolean) => void;
  /**
   * Leave for a reason the guard does not speak for — the save made the draft
   * the saved record, or the record the form edits no longer exists — so it
   * drops the unsaved-edit state without asking and then runs `leave`.
   */
  leaveWithoutAsking: (leave: () => void) => void;
  /** The discard confirmation; render it inside the screen. */
  dialog: ReactNode;
}>;

/**
 * Keep editing / Discard gate for the profile Overview's metadata form, and for
 * any other screen whose Back press must not drop an unsaved form silently.
 *
 * The header back arrow, Android Back and the back gesture all remove this
 * route, so one `usePreventRemove` covers all three. The edit flag lives in a
 * ref as well as state: the removal handler reads the ref, because a form that
 * a delete or a save has just cleaned reports that in the render after the one
 * that still has the guard on.
 *
 * `isDirty` drives the flag for screens whose dirty state is a computation over
 * their own state (the New trigger draft), instead of a form's `onDirtyChange`
 * callback: the guard recomputes it on every render, and `handleDirtyChange`
 * stays the manual path for forms that report dirtiness from events.
 *
 * Discard replays the intercepted navigation action from an effect, after the
 * render that disarms the guard: the replay dispatches the action again, and a
 * listener still armed would intercept it a second time.
 */
export function useMetadataLeaveGuard({
  enabled,
  isDirty,
}: Readonly<{
  /** False for a read-only viewer, who cannot have edited the form. */
  enabled: boolean;
  /**
   * The screen's unsaved-edit test, re-read on every render. Omit it on a form
   * that reports dirtiness through `handleDirtyChange` instead.
   */
  isDirty?: () => boolean;
}>): MetadataLeaveGuard {
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [leaveAllowed, setLeaveAllowed] = useState(false);
  const leavingRef = useRef(false);
  // A derived dirty screen reports its flag during render, the way React state
  // derivations work: the comparison keys on the state value, so a discarded
  // render pass leaves no stranded flag, and the state update still runs when
  // this render commits. A screen that is leaving stops recomputing — the draft
  // the create just saved still differs from a fresh form, and the recompute
  // would re-arm the guard in the render after the clear, turning the route's
  // removal into a prompt about a save that already landed. The latch clears
  // again once the leave has settled: the push-then-retire hand-off drops the
  // retire when the source becomes focused again, so the create screen can
  // survive its own leave and must keep asking about a later edit.
  if (isDirty !== undefined && !leavingRef.current) {
    const next = isDirty();
    if (next !== dirty) {
      setDirty(next);
    }
  }
  const pendingLeaveRef = useRef<(() => void) | null>(null);
  const replayRef = useRef<(() => void) | null>(null);
  const [leaveCount, setLeaveCount] = useState(0);

  const handleDirtyChange = useCallback((next: boolean) => {
    dirtyRef.current = next;
    setDirty(next);
  }, []);

  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(leaveTimerRef.current);
    },
    []
  );
  const leaveWithoutAsking = useCallback((leave: () => void) => {
    // A derived `isDirty` screen stops recomputing while it is leaving: the
    // draft the create just saved still differs from a fresh form, and the
    // recompute would re-arm the guard in the render after this clear, turning
    // the route's removal into a prompt about a save that already landed.
    leavingRef.current = true;
    dirtyRef.current = false;
    setDirty(false);
    // The leave waits one task for the render that disarms the guard. Clearing
    // the edit flag and leaving in one turn asks the native stack to change this
    // route's `preventRemove` option and start its pop transition together: the
    // option change lands after the transition began, react-native-screens
    // re-mounts the screen header, and Fabric throws `addViewAt … The specified
    // child already has a parent` (Sentry KILO-APP-25). Nothing else on the
    // screen moves between the two, so one task is enough for the disarm to
    // reach the native side first — and the pop is then a plain pop.
    clearTimeout(leaveTimerRef.current);
    leaveTimerRef.current = setTimeout(() => {
      leaveTimerRef.current = undefined;
      leave();
      // The leave has been dispatched, so the disarm render is behind us and
      // the recompute can resume: if the leave turned out to drop the route,
      // the latch dies with the mount; if the route survived (a hand-off whose
      // retire the navigator refused), the next render re-arms the guard.
      leavingRef.current = false;
    }, 0);
  }, []);

  // The removal handler reads the ref, so it must trail the committed state
  // rather than the render pass: an effect writes it after React accepts the
  // render, and a discarded pass writes nothing.
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  usePreventRemove(enabled && dirty && !leaveAllowed, ({ data, repeat }) => {
    const leave = () => {
      replayRef.current = repeat;
      setLeaveAllowed(true);
      setLeaveCount(count => count + 1);
    };
    // Nothing is unsaved any more, or the navigator is doing something other
    // than leaving this screen, which the guard does not speak for.
    if (!dirtyRef.current || !isLeaveAction(data.action.type)) {
      leave();
      return;
    }
    pendingLeaveRef.current = leave;
    confirm({
      title: t('common.discardChangesTitle'),
      message: t('common.discardChangesMessage'),
      confirmLabel: t('common.discard'),
      cancelLabel: t('common.keepEditing'),
      onConfirm: () => {
        const pending = pendingLeaveRef.current;
        pendingLeaveRef.current = null;
        if (pending === null) {
          return;
        }
        // The disarm render is committed by the time `leave` queues the replay,
        // and the replay effect dispatches the removal after that render and
        // then takes the disarm back: a screen that survives the replay (its
        // retire was refused) is guarded again on its next edit.
        dirtyRef.current = false;
        setDirty(false);
        pending();
      },
      onCancel: () => {
        pendingLeaveRef.current = null;
        // The Back that opened this prompt never leaves the screen, so the
        // dismissal it would otherwise suppress is live again — a delete that
        // resolves now must still pop.
        clearAcceptedBack();
      },
    });
  });

  useEffect(() => {
    const replay = replayRef.current;
    replayRef.current = null;
    replay?.();
    // The removal is dispatched. The disarm covered exactly that replay: from
    // here on, an edit means the navigator kept this screen (its retire was
    // refused) and the guard owes it a prompt again, so the disarm clears in
    // this effect, after the replay is out — never during render, where a
    // state update alongside the navigator's own subscription re-renders in a
    // loop.
    setLeaveAllowed(false);
    // The removal handler's ref follows the committed state (the effect above
    // it). A Discard that the navigator granted popped the route, so the sync
    // already ran with `false` before any later render; a Discard the navigator
    // kept — the surviving hand-off case — commits this effect with `dirty`
    // still true from the edit, so re-syncing here re-arms the handler and the
    // next Back asks again. The render-phase recompute writes state only; the
    // ref it leaves behind stays the discarded render's `false`, so without
    // this write a kept screen's Back takes the silent-leave branch.
    if (isDirty !== undefined && !leavingRef.current) {
      dirtyRef.current = isDirty();
      setDirty(dirtyRef.current);
    }
  }, [leaveCount, isDirty]);

  return { handleDirtyChange, leaveWithoutAsking, dialog };
}
