import { usePreventRemove } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/dialog';
import { isLeaveAction } from '@/lib/navigation/leave-actions';
import { clearAcceptedBack } from '@/lib/navigation/leave-settle';
import { useNavigationFocusRead, useNavigationQueueSettled } from '@/lib/navigation/route-focus';

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
 * Keep editing / Discard gate for the profile Overview's metadata form, and for
 * any other screen whose Back press must not drop an unsaved form silently —
 * the profile Overview's name and description, the organization's mode and
 * group forms, and the trigger forms.
 *
 * The header back arrow, Android Back and the back gesture all remove this
 * route, so one `usePreventRemove` covers all three. While a create, update or
 * delete the form started is in flight the route stays and no prompt is raised.
 * The phase lives in a ref as well as in the rendered state: the removal handler
 * reads the ref, because a form that a delete or a save has just cleaned reports
 * that in the render after the one that still has the guard on.
 *
 * `isDirty` drives the flag for screens whose dirty state is a computation over
 * their own state (the New trigger draft), instead of a form's `onDirtyChange`
 * callback: the guard recomputes it on every render, and `handleDirtyChange`
 * stays the manual path for forms that report dirtiness from events.
 *
 * Discard replays the intercepted navigation action from an effect, after the
 * render that disarms the guard: the replay dispatches the action again, and a
 * listener still armed would intercept it a second time.
 *
 * `onDiscard` drops the form's durable draft once the person confirms Discard.
 * It runs only for that confirmation — a cancelled prompt keeps the draft — and
 * omitting it leaves the guard's behavior unchanged.
 */
export function useMetadataLeaveGuard({
  enabled,
  isDirty,
  saving,
  onDiscard,
}: Readonly<{
  /** False for a read-only viewer, who cannot have edited the form. */
  enabled: boolean;
  /**
   * The screen's unsaved-edit test, re-read on every render. Omit it on a form
   * that reports dirtiness through `handleDirtyChange` instead.
   */
  isDirty?: () => boolean;
  /** The form's create, update or delete is in flight. */
  saving: boolean;
  /** Drops the form's durable draft once the person confirms Discard. */
  onDiscard?: () => void;
}>): MetadataLeaveGuard {
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  const navigationFocusRead = useNavigationFocusRead();
  const queueSettled = useNavigationQueueSettled();
  const [dirty, setDirty] = useState(false);
  const [leaveAllowed, setLeaveAllowed] = useState(false);
  const leavingRef = useRef(false);
  // A derived dirty screen reports its flag during render, the way React state
  // derivations work: the comparison keys on the state value, so a discarded
  // render pass leaves no stranded flag, and the state update still runs when
  // this render commits. A screen that is leaving stops recomputing — the draft
  // the create just saved still differs from a fresh form, and the recompute
  // would re-arm the guard in the render after the clear, turning the route's
  // removal into a prompt about a save that already landed. The latch clears
  // again once the leave has settled and the route is still focused: the
  // push-then-retire hand-off drops the retire when the source becomes focused
  // again, so the create screen can survive its own leave and must keep asking
  // about a later edit.
  if (isDirty !== undefined && !leavingRef.current) {
    const next = isDirty();
    if (next !== dirty) {
      setDirty(next);
    }
  }
  const pendingLeaveRef = useRef<(() => void) | null>(null);
  const replayRef = useRef<(() => void) | null>(null);
  const [leaveCount, setLeaveCount] = useState(0);
  // Set by the pass that dispatches a replay, so the following pass judges the
  // dispatch against state that includes its queued intent.
  const [replayDraining, setReplayDraining] = useState(false);

  const state = leavePhase({ dirty, saving, leaveAllowed });
  const stateRef = useRef<MetadataLeaveState>({ kind: 'idle' });
  // Assigned during render on purpose: the handler registered by the render
  // that had the guard on still runs for a removal dispatched before the next
  // commit, and it must classify that removal by the phase the person sees.
  stateRef.current = state;
  // Same reason: the prompt is opened from that handler, so its `onConfirm`
  // must clear the draft through the newest `onDiscard` the form passed.
  const onDiscardRef = useRef(onDiscard);
  onDiscardRef.current = onDiscard;

  const handleDirtyChange = useCallback((next: boolean) => {
    // A route that stayed mounted after a caller-driven leave — a save whose pop
    // the navigator dropped, or a blurred tab — must guard the next draft again.
    if (next) {
      setLeaveAllowed(false);
    }
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
    setDirty(false);
    setLeaveAllowed(true);
    // The leave waits one task for the render that disarms the guard. Clearing
    // the edit flag and leaving in one turn asks the native stack to change this
    // route's `preventRemove` option and start its pop transition together: the
    // option change lands after the transition began, react-native-screens
    // re-mounts the screen header, and Fabric throws `addViewAt … The specified
    // child already has a parent` (Sentry KILO-APP-25). Nothing else on the
    // screen moves between the two, so one task is enough for the disarm to
    // reach the native side first — and the pop is then a plain pop. The guard is
    // already disarmed in this commit, so the native stack sees a plain pop
    // instead of a prevented removal it would have to replay.
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

  usePreventRemove(
    enabled && (state.kind === 'dirty' || state.kind === 'saving'),
    ({ data, repeat }) => {
      const leave = () => {
        replayRef.current = repeat;
        setLeaveAllowed(true);
        setLeaveCount(count => count + 1);
      };
      const current = stateRef.current;
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
          // The disarm render is committed by the time `leave` queues the replay,
          // and the replay effect dispatches the removal after that render and
          // then takes the disarm back once the queue that carries it has
          // drained: a screen that survives the replay (its retire was refused)
          // is guarded again on its next edit.
          setDirty(false);
          // The person confirmed Discard, so the draft they no longer want goes
          // with the screen. Cancel keeps it.
          onDiscardRef.current?.();
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
    if (replay !== null) {
      replay();
      // The dispatch only enqueues an intent, so this pass cannot tell a granted
      // pop from a refused replay; the flag makes the next pass run even when
      // nothing else about this screen changed, and that pass reads the queue
      // state the intent committed.
      setReplayDraining(true);
      return;
    }
    // The replay's dispatch enqueues an intent the root routing queue applies in
    // a later commit, and a focus read before that drain answers from the state
    // the dispatch was queued against: a granted pop still reports focused then,
    // and releasing the latch — re-enabling `usePreventRemove` — on that read
    // re-arms prevention on a route the pop is carrying away, the option change
    // that lands after the transition began, the header-remount shape the note
    // above records. A pass that dispatched never releases; the latch releases
    // only on a later pass where the queue has settled, and that pass reads
    // focus with the drained state to answer from: a granted pop unmounts this
    // screen in the drain commit, so the latch dies with the mount, while a
    // refused replay settles with this screen still mounted and focused and
    // re-arms here. A screen a pop buried stays latched until it renders focused
    // again — its next edit runs this effect and releases the latch then. Every
    // consumer releases with that focus evidence — a manual-dirty screen edits
    // again after a refused leave just as a derived one does — and only the
    // derived screen's dirty test and ref sync that to the form's own
    // computation.
    if (!replayDraining || !queueSettled || !navigationFocusRead()) {
      return;
    }
    setReplayDraining(false);
    setLeaveAllowed(false);
    if (isDirty !== undefined && !leavingRef.current) {
      const next = isDirty();
      setDirty(next);
    }
  }, [leaveCount, isDirty, navigationFocusRead, queueSettled, replayDraining]);

  return { handleDirtyChange, leaveWithoutAsking, dialog };
}
