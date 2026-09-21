import { useTranslation } from 'react-i18next';
import { Modal, Pressable, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

type DestructiveConfirmDialogProps = {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * In-app confirmation for a destructive action, rendered with the destructive
 * (red) button variant.
 *
 * One implementation on both platforms: `Alert.alert` has no cross-platform
 * destructive affordance. Android's native `AlertDialog` paints every button
 * with the theme accent, so `Alert.alert`'s `style: 'destructive'` never
 * reaches the screen there, while this `Modal`-based surface renders the red
 * choice on Android and iOS alike.
 *
 * Mount it only while it should be open (e.g. `{confirming && <DestructiveConfirmDialog ... />}`),
 * the same lifecycle `RenameModal` uses.
 */
export function DestructiveConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: Readonly<DestructiveConfirmDialogProps>) {
  const { t } = useTranslation();
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable accessible={false} className="flex-1 justify-center px-6" onPress={onCancel}>
        <View className="absolute inset-0 bg-black opacity-50" />
        <Pressable
          accessible={false}
          accessibilityViewIsModal
          className="gap-4 rounded-xl bg-card p-5"
          onPress={event => {
            event.stopPropagation();
          }}
        >
          <Text accessibilityRole="header" className="text-base font-semibold">
            {title}
          </Text>
          <Text className="text-sm text-muted-foreground">{message}</Text>
          <View className="flex-row justify-end gap-3">
            <Button variant="outline" onPress={onCancel}>
              <Text>{t('common.cancel')}</Text>
            </Button>
            <Button variant="destructive" onPress={onConfirm}>
              <Text>{confirmLabel}</Text>
            </Button>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
