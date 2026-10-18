import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';

export type DestructiveConfirmDialogProps = {
  title: string;
  message: string;
  confirmLabel: string;
  /** The safe choice's label; defaults to the generic Cancel. */
  cancelLabel?: string;
  /**
   * A third, non-destructive choice rendered between Cancel and the confirm —
   * for a confirmation that offers a way out other than "do it" or "don't",
   * such as discarding unsaved changes also offering Save.
   */
  extraAction?: { label: string; onPress: () => void };
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * In-app confirmation for a destructive action, rendered with the destructive
 * (red) button variant.
 *
 * The native `Alert.alert` cannot carry the affordance on Android: its
 * `AlertDialog` paints every button with the theme accent, so
 * `style: 'destructive'` never reaches the screen there. This surface renders
 * the confirm in-app on both platforms instead — one implementation, so the
 * destructive red fill and the neutral outline read the same everywhere.
 *
 * It is a native sheet, not an in-tree dialog: a confirm is reached from inside
 * `formSheet` routes and from content already presented in
 * `SessionPageSheet`, where a `@rn-primitives/portal` dialog would render
 * behind the sheet. The sheet sizes to the card and carries no drag indicator,
 * so the stacked buttons are the choices. Both native sheets already keep their
 * content above the home indicator and the navigation bar, so the card adds no
 * bottom inset of its own.
 *
 * Keep the request mounted until native dismissal finishes. The action runs
 * afterward, so deleting its owner cannot empty the sheet during dismissal.
 */
export function DestructiveConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  extraAction,
  onConfirm,
  onCancel,
}: Readonly<DestructiveConfirmDialogProps>) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(true);
  const pendingAction = useRef<(() => void) | null>(null);

  function dismiss(action: () => void) {
    if (pendingAction.current !== null) {
      return;
    }
    pendingAction.current = action;
    setVisible(false);
  }

  return (
    <Sheet
      visible={visible}
      onClose={() => {
        dismiss(onCancel);
      }}
      onDismiss={() => {
        const action = pendingAction.current ?? onCancel;
        pendingAction.current = null;
        action();
      }}
      showHandle={false}
    >
      <View className="gap-5 px-5 pt-6">
        <View className="gap-2">
          <Text accessibilityRole="header" className="text-lg font-semibold">
            {title}
          </Text>
          <Text className="text-sm text-muted-foreground">{message}</Text>
        </View>
        <View className="gap-2">
          <Button
            variant="destructive"
            className="w-full"
            onPress={() => {
              dismiss(onConfirm);
            }}
          >
            <Text>{confirmLabel}</Text>
          </Button>
          {extraAction ? (
            <Button
              variant="secondary"
              className="w-full"
              onPress={() => {
                extraAction.onPress();
              }}
            >
              <Text>{extraAction.label}</Text>
            </Button>
          ) : null}
          <Button
            variant="outline"
            className="w-full"
            onPress={() => {
              dismiss(onCancel);
            }}
          >
            <Text>{cancelLabel ?? t('common.cancel')}</Text>
          </Button>
        </View>
      </View>
    </Sheet>
  );
}
