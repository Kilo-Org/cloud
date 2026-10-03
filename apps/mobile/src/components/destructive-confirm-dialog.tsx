import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
 * so the two buttons are the choices.
 *
 * Mount it only while it should be open (e.g. `{confirming && <DestructiveConfirmDialog ... />}`),
 * the same lifecycle `RenameModal` uses.
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
  const insets = useSafeAreaInsets();
  return (
    <Sheet visible onClose={onCancel} showHandle={false}>
      <View className="gap-4 px-5 pt-5" style={{ paddingBottom: insets.bottom + 20 }}>
        <Text accessibilityRole="header" className="text-base font-semibold">
          {title}
        </Text>
        <Text className="text-sm text-muted-foreground">{message}</Text>
        <View className="flex-row justify-end gap-3">
          <Button variant="outline" onPress={onCancel}>
            <Text>{cancelLabel ?? t('common.cancel')}</Text>
          </Button>
          {extraAction ? (
            <Pressable
              onPress={() => {
                extraAction.onPress();
              }}
              accessibilityRole="button"
              className="shrink-0 flex-row items-center justify-center rounded-md px-3 active:opacity-70"
            >
              <Text className="text-sm font-semibold text-foreground">{extraAction.label}</Text>
            </Pressable>
          ) : null}
          <Button variant="destructive" onPress={onConfirm}>
            <Text>{confirmLabel}</Text>
          </Button>
        </View>
      </View>
    </Sheet>
  );
}
