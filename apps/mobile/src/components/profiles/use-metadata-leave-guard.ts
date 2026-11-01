import { usePreventRemove } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/dialog';
import { isLeaveAction } from '@/lib/navigation/leave-actions';

export type MetadataLeaveGuard = Readonly<{
  /** Wire this to the metadata form's `onDirtyChange`. */
  handleDirtyChange: (dirty: boolean) => void;
  /**
   * Drop the unsaved-edit state without asking. The caller is leaving for a
   * reason the guard does not speak for, as after a delete.
   */
  markClean: () => void;
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

  const markClean = useCallback(() => {
    dirtyRef.current = false;
    setDirty(false);
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
      },
    });
  });

  useEffect(() => {
    const replay = replayRef.current;
    replayRef.current = null;
    replay?.();
  }, [leaveCount]);

  return { handleDirtyChange, markClean, dialog };
}
