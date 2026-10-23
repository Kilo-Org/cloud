import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Check } from '@/components/ui/icons';
import { RadioGroup, radioItemA11y } from '@/components/ui/radio-group';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

export type MenuSheetOption = Readonly<{
  label: string;
  /**
   * The option destroys something (a member, a stored value). It keeps the
   * platform's red affordance on the row.
   */
  destructive?: boolean;
  /**
   * The option is the current choice of a single-select menu. Defining it on
   * the options makes the menu a radio group: each row exposes its checked
   * state and only the current one paints a check.
   */
  selected?: boolean;
}>;

type MenuSheetProps = Readonly<{
  visible: boolean;
  /** Heading above the rows; omit for a bare list. */
  title?: string;
  options: readonly MenuSheetOption[];
  cancelLabel: string;
  /** The chosen row, by index into `options`. */
  onSelect: (index: number) => void;
  /** The sheet started closing; `onDismiss` reports when it is gone. */
  onClose: () => void;
  /** The sheet finished its dismiss animation. */
  onDismiss?: () => void;
  /** The sheet is dismissing itself (Android Back, backdrop tap). */
  onRequestDismiss?: () => boolean;
}>;

/**
 * A menu of actions over the sheet's own native surface.
 *
 * It replaces the library action sheet for organization management: that one
 * presents a separate Android dialog window, which owns the back key while it
 * closes. A press during that teardown was dropped before the app could see
 * it, so a sheet opened from a row tap could neither be cancelled nor
 * dismissed. This sheet lives in the app's own window — the same surface every
 * other overlay uses — and answers Android Back through `Sheet`'s dismissal.
 */
export function MenuSheet({
  visible,
  title,
  options,
  cancelLabel,
  onSelect,
  onClose,
  onDismiss,
  onRequestDismiss,
}: MenuSheetProps) {
  // The sheet stays mounted through its dismiss animation, so it keeps
  // rendering after `visible` turns false and a caller can act on `onDismiss`.
  return (
    <MenuSheetBody
      {...{ visible, title, options, cancelLabel, onSelect, onClose, onDismiss, onRequestDismiss }}
    />
  );
}

function MenuSheetBody({
  visible,
  title,
  options,
  cancelLabel,
  onSelect,
  onClose,
  onDismiss,
  onRequestDismiss,
}: MenuSheetProps) {
  const { bottom } = useSafeAreaInsets();
  const colors = useThemeColors();
  // A menu whose options name a current choice is a radio group, so a screen
  // reader hears which role (or value) is already set.
  const isSingleSelect = options.some(option => option.selected !== undefined);

  const rows = options.map((option, index) => (
    <Pressable
      key={option.label}
      {...(isSingleSelect
        ? radioItemA11y({ label: option.label, checked: option.selected === true })
        : { accessibilityRole: 'button' as const, accessibilityLabel: option.label })}
      className={cn(
        'min-h-11 flex-row items-center gap-2 px-4 py-3 active:bg-secondary',
        index < options.length - 1 && 'border-b-[0.5px] border-hair-soft'
      )}
      onPress={() => {
        onSelect(index);
      }}
    >
      {isSingleSelect ? (
        <View className="w-4 items-center">
          {option.selected ? <Check size={16} color={colors.primary} /> : null}
        </View>
      ) : null}
      <Text
        className={cn(
          'min-w-0 flex-1 text-sm font-medium',
          option.destructive ? 'text-destructive' : 'text-foreground'
        )}
        numberOfLines={1}
      >
        {option.label}
      </Text>
    </Pressable>
  ));

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      onDismiss={onDismiss}
      onRequestDismiss={onRequestDismiss}
    >
      <View style={{ paddingBottom: bottom + 12 }}>
        {title ? (
          <Text
            accessibilityRole="header"
            className="px-4 py-3 text-center text-sm font-semibold text-muted-foreground"
            numberOfLines={2}
          >
            {title}
          </Text>
        ) : null}
        {isSingleSelect && title ? <RadioGroup label={title}>{rows}</RadioGroup> : rows}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={cancelLabel}
          className="mt-1 min-h-11 items-center justify-center px-4 py-3 active:bg-secondary"
          onPress={onClose}
        >
          <Text className="text-sm font-medium text-foreground">{cancelLabel}</Text>
        </Pressable>
      </View>
    </Sheet>
  );
}
