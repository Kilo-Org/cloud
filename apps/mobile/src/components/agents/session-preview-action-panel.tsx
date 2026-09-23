import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { type SessionActionMenu, type SessionActionMenuItem } from './session-row-actions';

type SessionPreviewActionPanelProps = {
  menu: SessionActionMenu;
  /** A row was chosen; the caller closes the preview first, then runs it. */
  onSelect: (item: SessionActionMenuItem) => void;
  onCancel: () => void;
};

/**
 * The preview's action panel: one row per item `buildSessionActionMenuItems`
 * produced, in the same order and with the same labels, plus the builder's own
 * Cancel label. Destructive rows take the destructive ink; nothing else
 * changes their appearance, so the panel cannot drift from the action sheet.
 */
export function SessionPreviewActionPanel({
  menu,
  onSelect,
  onCancel,
}: Readonly<SessionPreviewActionPanelProps>) {
  return (
    <View className="mt-3 overflow-hidden rounded-3xl bg-card">
      {menu.items.map((item, index) => (
        <Pressable
          key={item.key}
          accessibilityRole="button"
          accessibilityLabel={item.label}
          onPress={() => {
            onSelect(item);
          }}
          className={cn(
            'min-h-[44px] justify-center px-5 py-3 active:bg-muted',
            index > 0 && 'border-t-[0.5px] border-hair-soft'
          )}
        >
          <Text className={cn('text-base', item.destructive && 'text-destructive')}>
            {item.label}
          </Text>
        </Pressable>
      ))}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={menu.cancelLabel}
        onPress={onCancel}
        className="min-h-[44px] justify-center border-t-[0.5px] border-hair-soft px-5 py-3 active:bg-muted"
      >
        <Text className="text-base">{menu.cancelLabel}</Text>
      </Pressable>
    </View>
  );
}
