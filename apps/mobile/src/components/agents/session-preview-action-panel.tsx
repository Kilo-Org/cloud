import { type Ref } from 'react';
import { Pressable, type ViewInstance } from 'react-native';

import { RowGroup } from '@/components/ui/row-group';
import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

import { type SessionActionMenu, type SessionActionMenuItem } from './session-row-actions';

type SessionPreviewActionPanelProps = {
  menu: SessionActionMenu;
  /** A row was chosen; the caller closes the preview first, then runs it. */
  onSelect: (item: SessionActionMenuItem) => void;
  onCancel: () => void;
  /**
   * Attached to the first action row. The overlay passes a callback ref so
   * VoiceOver focus moves when the portal actually mounts the row — an effect
   * on open runs before the portal has rendered it.
   */
  firstItemRef?: Ref<ViewInstance>;
};

/**
 * The preview's action panel: one row per item `buildSessionActionMenuItems`
 * produced, in the same order and with the same labels, plus the builder's own
 * Cancel label. It is the grouped-row surface (`RowGroup`), which draws the
 * hairline between rows and none after the last, so the panel cannot re-spell
 * the row anatomy. Destructive rows take the destructive ink; nothing else
 * changes their appearance, so the panel cannot drift from the action sheet.
 */
export function SessionPreviewActionPanel({
  menu,
  onSelect,
  onCancel,
  firstItemRef,
}: Readonly<SessionPreviewActionPanelProps>) {
  return (
    <RowGroup className="mt-3">
      {[
        ...menu.items.map((item, index) => (
          <Pressable
            key={item.key}
            ref={index === 0 ? firstItemRef : undefined}
            accessibilityRole="button"
            accessibilityLabel={item.label}
            onPress={() => {
              onSelect(item);
            }}
            className={cn(ROW_TARGET_CLASS, 'justify-center px-4 py-3 active:bg-muted')}
          >
            <Text className={cn('text-base', item.destructive && 'text-destructive')}>
              {item.label}
            </Text>
          </Pressable>
        )),
        <Pressable
          key="cancel"
          accessibilityRole="button"
          accessibilityLabel={menu.cancelLabel}
          onPress={onCancel}
          className={cn(ROW_TARGET_CLASS, 'justify-center px-4 py-3 active:bg-muted')}
        >
          <Text className="text-base">{menu.cancelLabel}</Text>
        </Pressable>,
      ]}
    </RowGroup>
  );
}
