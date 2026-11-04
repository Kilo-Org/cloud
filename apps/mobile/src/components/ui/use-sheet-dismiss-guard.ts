import { type ReactNode, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/dialog';

type SheetDismissGuard = {
  /**
   * Close the sheet, or ask Keep editing / Discard first when the form has
   * unsaved edits. Pass it to the header's Cancel control.
   */
  requestClose: () => void;
  /**
   * The sheet's `onRequestDismiss`. A clean form lets the native dismissal run;
   * a dirty one shows the confirm and returns false, which keeps the sheet up.
   */
  requestDismiss: () => boolean;
  /** The confirmation to render inside the sheet; null while it is closed. */
  dialog: ReactNode;
};

/**
 * Keep editing / Discard gate for a form sheet.
 *
 * A full-window sheet no longer dismisses by a drag (that gesture belongs to the
 * form's scroll view), so its dismissal paths are the header's Cancel control
 * and Android Back. Both run through this guard, and both ask first when the
 * form holds edits the user has not saved.
 *
 * `isDirty` is read when the dismissal happens, not on every render: the profile
 * form sheets keep their text in refs, so a state flag would lag the field the
 * user just typed in.
 */
export function useSheetDismissGuard({
  isDirty,
  onDiscard,
}: Readonly<{
  isDirty: () => boolean;
  /** Drop the edits and close. Runs only once the user confirms. */
  onDiscard: () => void;
}>): SheetDismissGuard {
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();

  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;
  const onDiscardRef = useRef(onDiscard);
  onDiscardRef.current = onDiscard;

  const confirmDiscard = useCallback(() => {
    confirm({
      title: t('common.discardChangesTitle'),
      message: t('common.discardChangesMessage'),
      confirmLabel: t('common.discard'),
      cancelLabel: t('common.keepEditing'),
      onConfirm: () => {
        onDiscardRef.current();
      },
    });
  }, [confirm, t]);

  const requestClose = useCallback(() => {
    if (isDirtyRef.current()) {
      confirmDiscard();
      return;
    }
    onDiscardRef.current();
  }, [confirmDiscard]);

  const requestDismiss = useCallback(() => {
    if (!isDirtyRef.current()) {
      return true;
    }
    confirmDiscard();
    return false;
  }, [confirmDiscard]);

  return { requestClose, requestDismiss, dialog };
}
