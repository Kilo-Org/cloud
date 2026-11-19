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
 * What a Back press means right now:
 * - `idle`: nothing unsaved and no write in flight, so the guard is off;
 * - `dirty`: unsaved edits, so the person chooses Keep editing or Discard;
 * - `saving`: a write this form started is in flight, so the removal is dropped
 *   and no prompt is raised — the draft it would discard is already committed to
 *   a request;
 * - `leaving`: the guard is replaying the removal it allowed, so it stands aside.
 */
type MetadataLeaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'dirty' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'leaving' };

/**
 * The phase a form is in. Precedence: the guard's own replay, then the write in
 * flight, then unsaved edits, then nothing to speak for.
 */
function leavePhase({
  dirty,
  saving,
  leaveAllowed,
}: Readonly<{
  dirty: boolean;
  saving: boolean;
  leaveAllowed: boolean;
}>): MetadataLeaveState {
  if (leaveAllowed) {
    return { kind: 'leaving' };
  }
  if (saving) {
    return { kind: 'saving' };
  }
  return dirty ? { kind: 'dirty' } : { kind: 'idle' };
}

/**
 * Keep editing / Discard gate for the metadata forms: the profile Overview's
 * name and description, and the organization's mode and group forms.
 *
 * The header back arrow, Android Back and the back gesture all remove this
 * route, so one `usePreventRemove` covers all three. While a create, update or
 * delete the form started is in flight the route stays and no prompt is raised.
 * The phase lives in a ref as well as in the rendered state: the removal handler
 * reads the ref, because a form that a delete or a save has just cleaned reports
 * that in the render after the one that still has the guard on.
 *
 * Discard replays the intercepted navigation action from an effect, after the
 * render that disarms the guard: the replay dispatches the action again, and a
 * listener still armed would intercept it a second time.
 */
export function useMetadataLeaveGuard({
  enabled,
  saving,
}: Readonly<{
  /** False for a read-only viewer, who cannot have edited the form. */
  enabled: boolean;
  /** The form's create, update or delete is in flight. */
  saving: boolean;
}>): MetadataLeaveGuard {
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  const [dirty, setDirty] = useState(false);
  const [leaveAllowed, setLeaveAllowed] = useState(false);
  const pendingLeaveRef = useRef<(() => void) | null>(null);
  const replayRef = useRef<(() => void) | null>(null);
  const [leaveCount, setLeaveCount] = useState(0);
  // Set while a caller-driven leave, whose draft is already cleared, is being
  // dispatched; see `leaveWithoutAsking`.
  const forcedLeaveRef = useRef(false);

  const state = leavePhase({ dirty, saving, leaveAllowed });
  const stateRef = useRef<MetadataLeaveState>({ kind: 'idle' });
  // Assigned during render on purpose: the handler registered by the render
  // that had the guard on still runs for a removal dispatched before the next
  // commit, and it must classify that removal by the phase the person sees.
  stateRef.current = state;

  const handleDirtyChange = useCallback((next: boolean) => {
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
    forcedLeaveRef.current = true;
    leaveTimerRef.current = setTimeout(() => {
      leaveTimerRef.current = undefined;
      leave();
      // The navigator consults the guard synchronously inside `leave()`, so the
      // mark is spent by now: a removal that never reached an armed guard (one
      // this form's write already disarmed) must not swallow a later Back.
      forcedLeaveRef.current = false;
    }, 0);
  }, []);

  usePreventRemove(
    enabled && (state.kind === 'dirty' || state.kind === 'saving'),
    ({ data, repeat }) => {
      const leave = () => {
        replayRef.current = repeat;
        setLeaveAllowed(true);
        setLeaveCount(count => count + 1);
      };
      const current = stateRef.current;
      // A caller-driven leave whose draft is already cleared stands aside even
      // while the write that produced it still reports pending, so the save's own
      // pop is never mistaken for a Back press.
      if (forcedLeaveRef.current) {
        leave();
        return;
      }
      // A write this form started owns the route until it settles: a Back press
      // is dropped without asking, because Discard would pop a screen whose
      // request still lands and nothing on the screen can call that request back.
      // The Back never leaves, so its accepted mark has to be freed the way the
      // discard prompt's `onCancel` frees it — otherwise the save's own pop is
      // spent on a mark nothing will apply. A forward removal is not a Back
      // press, so it leaves as it does elsewhere.
      if (current.kind === 'saving') {
        if (!isLeaveAction(data.action.type)) {
          leave();
          return;
        }
        clearAcceptedBack();
        return;
      }
      // Nothing is unsaved any more, or the navigator is doing something other
      // than leaving this screen, which the guard does not speak for.
      if (current.kind !== 'dirty' || !isLeaveAction(data.action.type)) {
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
    }
  );

  useEffect(() => {
    const replay = replayRef.current;
    replayRef.current = null;
    replay?.();
  }, [leaveCount]);

  return { handleDirtyChange, leaveWithoutAsking, dialog };
}
