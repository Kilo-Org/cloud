import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Modal, Platform, Pressable, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

type DestructiveConfirmContent = {
  title: string;
  message: string;
  confirmLabel: string;
};

type DestructiveConfirm = {
  confirm: () => void;
  dialog: ReactNode;
};

type DestructiveConfirmDialogProps = DestructiveConfirmContent & {
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * In-app confirmation for a destructive action, rendered with the destructive
 * (red) button variant.
 *
 * Android's native `AlertDialog` paints every button with the theme accent, so
 * `Alert.alert`'s `style: 'destructive'` never reaches the screen there (iOS
 * honors it and keeps the native alert). Android renders this surface instead,
 * so the destructive choice still carries the red affordance.
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

/**
 * Opens the platform-appropriate confirmation for one destructive action.
 *
 * iOS keeps the native `Alert.alert`, whose `style: 'destructive'` already
 * renders the choice in red (`apps/mobile/AGENTS.md`: "Confirm destructive
 * actions with `Alert.alert()`"). Android's native alert paints every button
 * with the theme accent, so `confirm` opens the in-app dialog instead and the
 * returned `dialog` element carries the destructive affordance there.
 *
 * Call `confirm` from the control that should ask first, and render `dialog`
 * next to the screen's other overlays:
 *
 * ```
 * const { confirm, dialog } = useDestructiveConfirm(content, onConfirmed);
 * // <ActionTile onPress={confirm} ... />
 * // {dialog}
 * ```
 */
export function useDestructiveConfirm(
  content: DestructiveConfirmContent,
  onConfirm: () => void
): DestructiveConfirm {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const confirm = () => {
    if (Platform.OS === 'android') {
      setVisible(true);
      return;
    }
    Alert.alert(content.title, content.message, [
      { text: t('common.cancel'), style: 'cancel' },
      { text: content.confirmLabel, style: 'destructive', onPress: onConfirm },
    ]);
  };
  const dialog = visible ? (
    <DestructiveConfirmDialog
      title={content.title}
      message={content.message}
      confirmLabel={content.confirmLabel}
      onCancel={() => {
        setVisible(false);
      }}
      onConfirm={() => {
        setVisible(false);
        onConfirm();
      }}
    />
  ) : null;
  return { confirm, dialog };
}
