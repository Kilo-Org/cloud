import { useEffect } from 'react';

import { DestructiveConfirmDialog } from '@/components/destructive-confirm-dialog';
import { i18n } from '@/i18n';
import {
  answerSettingsConfirm,
  forgetSettingsConfirm,
  setSettingsConfirmHostMounted,
  settleAllSettingsConfirms,
  useSettingsConfirmRequest,
} from '@/lib/settings/confirm';

/**
 * Draws the confirmation a settings tool call is waiting on. Mounted once at
 * the app root so a call made from any screen, including one outside the
 * authenticated tabs, has a host to answer it. The dialog's sheet owns Android
 * Back, the scrim and the iOS backdrop tap, so every dismissal cancels.
 *
 * A withdrawn request (its tool call was interrupted) keeps its place in the
 * queue and its sheet on the screen: pulling the sheet out mid-presentation
 * leaves the scrim stuck, so the dialog is asked to dismiss it the way a Cancel
 * does and the host removes the request only once the sheet has reported.
 */
export function SettingsConfirmHost() {
  const request = useSettingsConfirmRequest();

  useEffect(() => {
    setSettingsConfirmHostMounted(true);
    return () => {
      setSettingsConfirmHostMounted(false);
      settleAllSettingsConfirms(false);
    };
  }, []);

  if (request === undefined) {
    return null;
  }

  return (
    <DestructiveConfirmDialog
      // A fresh dialog per request: the sheet of a settled request is already
      // dismissing, so the next request would update it behind a closed sheet.
      key={request.id}
      title={i18n.t('settingsTools.confirmTitle')}
      message={request.summary}
      confirmLabel={i18n.t('common.save')}
      cancelLabel={i18n.t('common.cancel')}
      // An interrupted call's sheet goes out through the dialog's own Cancel
      // path, so the native dismissal animates and reports.
      dismissRequested={request.withdrawn}
      onConfirm={() => {
        answerSettingsConfirm(request.id, true);
      }}
      onCancel={() => {
        if (request.withdrawn) {
          // The dismissal report for a request no tool call waits on: nothing
          // to answer, only the queue entry to remove.
          forgetSettingsConfirm(request.id);
          return;
        }
        answerSettingsConfirm(request.id, false);
      }}
    />
  );
}
