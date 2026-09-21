import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Platform } from 'react-native';

import { DestructiveConfirmDialog } from '@/components/destructive-confirm-dialog';

/** Everything a destructive confirmation needs to render and to act. */
type DestructiveConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
};

/**
 * Confirms a destructive action with the red affordance each platform can
 * actually render.
 *
 * iOS honors `Alert.alert`'s `style: 'destructive'`, so it keeps the native
 * alert (`apps/mobile/AGENTS.md`: prefer native alerts). Android's native
 * `AlertDialog` paints every button with the theme accent, so the destructive
 * style never reaches the screen there; Android renders the in-app
 * `DestructiveConfirmDialog` instead, whose confirm control carries the
 * destructive (red) variant.
 *
 * Mount `dialog` next to the screen content (`{confirm.dialog}`); it renders
 * `null` until a confirmation is requested, the same lifecycle `RenameModal`
 * uses.
 */
export function useDestructiveConfirm() {
  const { t } = useTranslation();
  const [request, setRequest] = useState<DestructiveConfirmRequest | null>(null);

  return {
    request(next: DestructiveConfirmRequest) {
      if (Platform.OS === 'android') {
        setRequest(next);
        return;
      }
      Alert.alert(next.title, next.message, [
        { text: t('common.cancel'), style: 'cancel' },
        { text: next.confirmLabel, style: 'destructive', onPress: next.onConfirm },
      ]);
    },
    dialog:
      request == null ? null : (
        <DestructiveConfirmDialog
          title={request.title}
          message={request.message}
          confirmLabel={request.confirmLabel}
          onCancel={() => {
            setRequest(null);
          }}
          onConfirm={() => {
            setRequest(null);
            request.onConfirm();
          }}
        />
      ),
  };
}
