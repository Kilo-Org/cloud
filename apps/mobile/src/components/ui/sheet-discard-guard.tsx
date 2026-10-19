import { useCallback, useEffect, useRef } from 'react';
import { BackHandler } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/dialog';

/** The guard's contract: route closes through the gate, render the confirm. */
type SheetDiscardGuard = {
  /** Route every close affordance through this instead of `onClose`. */
  requestClose: () => void;
  /** Render this node in the same tree that owns the sheet. */
  confirmDialog: React.ReactNode;
};

/**
 * Discard confirmation for a form inside a native sheet whose scroll-dismiss
 * gesture is off (`SessionPageSheet`). Every close path the form does not own —
 * the header's Cancel, an Android Back — routes through `requestClose`, which
 * lets a clean form close at once and asks "Keep editing / Discard" when the
 * form reports unsaved changes.
 *
 * `isDirty` is a function, not a boolean: the app's text fields are
 * uncontrolled (their live values live in refs, `apps/mobile/AGENTS.md`), so
 * typing never re-renders and a render-time flag would go stale. The gate
 * evaluates the form at the moment of the close attempt.
 *
 * The confirm is the shared `useConfirmDialog` native sheet, which stacks above
 * the presenting sheet by design (`@/components/ui/dialog`). The hook also owns
 * hardware Back for the sheet's lifetime: the shared `Sheet` disables the
 * library's own Back dismissal for a non-pan-dismissable sheet, so without this
 * the Android back gesture would do nothing while the form is open. On iOS the
 * listener never fires.
 *
 * Render `confirmDialog` inside the sheet (or beside it in the same tree), and
 * pass `requestClose` to the close affordances instead of `onClose` directly.
 */
export function useSheetDiscardGuard({
  isDirty,
  onClose,
}: Readonly<{
  /** Answers at close time whether the form holds unsaved changes. */
  isDirty: () => boolean;
  /** The sheet's close: clear the form state so the sheet unmounts. */
  onClose: () => void;
}>): SheetDiscardGuard {
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();

  // Latest-value refs: Back is armed once per mount and must run the current
  // render's gate and close (a stale closure would read the first render's).
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const requestClose = useCallback(() => {
    if (!isDirtyRef.current()) {
      onCloseRef.current();
      return;
    }
    confirm({
      title: t('sheet.discardTitle'),
      message: t('sheet.discardMessage'),
      confirmLabel: t('common.discard'),
      cancelLabel: t('common.keepEditing'),
      onConfirm: () => {
        onCloseRef.current();
      },
    });
  }, [confirm, t]);

  // Hardware Back belongs to the sheet while it is open: the shared `Sheet`
  // disables the library's own Back dismissal for a non-pan-dismissable sheet,
  // so the form's guard is the only handler. Consuming the event keeps the
  // underlying screen from popping behind the sheet.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      requestClose();
      return true;
    });
    return () => {
      sub.remove();
    };
  }, [requestClose]);

  return { requestClose, confirmDialog: dialog };
}
