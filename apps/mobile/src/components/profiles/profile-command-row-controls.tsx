import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { ChevronDown, ChevronUp, Trash2 } from '@/components/ui/icons';
import { cn } from '@/lib/utils';
import { LABELLED_LINE_ACTION_CLASS, LABELLED_LINE_ACTION_HIT_SLOP } from '@/lib/a11y/tap-target';

function LineIconButton({
  label,
  hint,
  disabled,
  onPress,
  children,
}: Readonly<{
  label: string;
  hint: string;
  disabled?: boolean;
  onPress: () => void;
  children: ReactNode;
}>) {
  // React Native keeps a touch area inside its parent's bounds, so a box that
  // floats over the label line is only as tall as that line. The control is the
  // 44 dp target itself instead, and the label row lays itself out one target
  // tall so the extra height falls below the label rather than above it.
  return (
    <Pressable
      className={cn(LABELLED_LINE_ACTION_CLASS, 'active:opacity-70', disabled && 'opacity-40')}
      hitSlop={LABELLED_LINE_ACTION_HIT_SLOP}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={onPress}
    >
      {children}
    </Pressable>
  );
}

/**
 * A setup command field's reorder and delete controls. They sit on the field's
 * own label line as its accessory, so the card is its label row and its input
 * and carries no separate control band under the input. They still name their
 * own position, and the row's 10.5 dp gap keeps the neighbouring 5 dp slop
 * bands apart (10 dp), so a tap beside one control never reaches the next.
 */
export function ProfileCommandRowControls({
  color,
  hint,
  upLabel,
  downLabel,
  deleteLabel,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onDelete,
}: Readonly<{
  color: string;
  hint: string;
  upLabel: string;
  downLabel: string;
  deleteLabel: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}>) {
  return (
    <View className="flex-row items-center gap-3">
      <LineIconButton label={upLabel} hint={hint} disabled={!canMoveUp} onPress={onMoveUp}>
        <ChevronUp size={20} color={color} />
      </LineIconButton>
      <LineIconButton label={downLabel} hint={hint} disabled={!canMoveDown} onPress={onMoveDown}>
        <ChevronDown size={20} color={color} />
      </LineIconButton>
      <LineIconButton label={deleteLabel} hint={hint} onPress={onDelete}>
        <Trash2 size={20} color={color} />
      </LineIconButton>
    </View>
  );
}
