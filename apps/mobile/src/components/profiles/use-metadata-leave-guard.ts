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
 * Keep editing / Discard gate for the profile Overview's metadata form.
 *
 * The header back arrow, Android Back and the back gesture all remove this
 * route, so one `usePreventRemove` covers all three. The edit flag lives in a
 * ref as well as state: the removal handler reads the ref, because a form that
 * a delete or a save has just cleaned reports that in the render after the one
 * that still has the guard on.
 *
 * Discard replays the intercepted navigation action from an effect, after the
 * render that disarms the guard: the replay dispatches the action again, and a
 * listener still armed would intercept it a second time.
 */
export function useMetadataLeaveGuard({
  enabled,
}: Readonly<{
  /** False for a read-only viewer, who cannot have edited the form. */
  enabled: boolean;
}>): MetadataLeaveGuard {
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [leaveAllowed, setLeaveAllowed] = useState(false);
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
    }, 0);
  }, []);

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
  }, [leaveCount]);

  return { handleDirtyChange, leaveWithoutAsking, dialog };
}
