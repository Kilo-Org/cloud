import { Portal } from '@rn-primitives/portal';
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
 * The dialog renders through the portal, into the app-root `PortalHost`. On the
 * other platform a native sheet's content renders inside the app's React tree,
 * and the root wraps that tree in a veil — `pointerEvents="none"`,
 * `accessibilityElementsHidden`, `no-hide-descendants` — for as long as an
 * in-tree modal surface (a `DialogCard`, the session preview overlay) is open.
 * This host is mounted inside that tree, so a confirm it drew inline would be
 * untappable and unannounced exactly when a modal screen asks for one. The
 * portal host sits outside the veil, which keeps the confirm tappable and
 * announced.
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
    <Portal name="settings-confirm">
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
    </Portal>
  );
}
