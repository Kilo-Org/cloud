import { type ReactNode } from 'react';
import { View } from 'react-native';

import { ChevronDown, ChevronUp, Pencil, Trash2 } from '@/components/ui/icons';
import { RowIconAction } from '@/components/ui/row-trailing';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * One control of a reorderable item's action line. The icon is the control's
 * only ink, so `label` is its whole accessible name.
 */
export type ReorderableItemAction = Readonly<{
  label: string;
  /** The item's place in the list, which a name cannot carry. */
  hint?: string;
  disabled?: boolean;
  /** Test handle for native E2E scripts. */
  testID?: string;
  onPress: () => void;
}>;

type ReorderableItemActionsProps = Readonly<{
  moveUp?: ReorderableItemAction;
  moveDown?: ReorderableItemAction;
  edit?: ReorderableItemAction;
  remove?: ReorderableItemAction;
}>;

/**
 * The action line every reorderable item ends with: move, edit and delete at
 * the item's end, in that order. The controls sit 17.5pt apart, so the 8pt
 * reach each side of a neighbouring hit slop (16pt together) stays clear of it
 * and a tap between two controls belongs to the gap, never to one of them.
 */
export function ReorderableItemActions({
  moveUp,
  moveDown,
  edit,
  remove,
}: ReorderableItemActionsProps) {
  const colors = useThemeColors();
  if (
    moveUp === undefined &&
    moveDown === undefined &&
    edit === undefined &&
    remove === undefined
  ) {
    return null;
  }
  return (
    <View className="flex-row items-center justify-end gap-5">
      {moveUp === undefined ? null : (
        <RowIconAction {...moveUp}>
          <ChevronUp size={20} color={colors.mutedForeground} />
        </RowIconAction>
      )}
      {moveDown === undefined ? null : (
        <RowIconAction {...moveDown}>
          <ChevronDown size={20} color={colors.mutedForeground} />
        </RowIconAction>
      )}
      {edit === undefined ? null : (
        <RowIconAction {...edit}>
          <Pencil size={20} color={colors.mutedForeground} />
        </RowIconAction>
      )}
      {remove === undefined ? null : (
        <RowIconAction {...remove}>
          <Trash2 size={20} color={colors.mutedForeground} />
        </RowIconAction>
      )}
    </View>
  );
}

type ReorderableItemProps = Readonly<{
  /** The item's own content: its title line, fields and detail lines. */
  children: ReactNode;
  /** The item's {@link ReorderableItemActions}, when the reader may change the list. */
  actions?: ReactNode;
}>;

/**
 * One item of a reorderable list: its content, then the action line it ends
 * with. Setup commands and slash commands share this one layout, so a list
 * that can be reordered reads and behaves the same wherever it appears, and
 * the item's inset and internal gap have a single owner.
 */
export function ReorderableItem({ children, actions }: ReorderableItemProps) {
  return (
    <View className="gap-3 px-4 py-3">
      {children}
      {actions}
    </View>
  );
}
