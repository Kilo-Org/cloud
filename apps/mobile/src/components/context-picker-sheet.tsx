import { Check } from '@/components/ui/icons';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RadioGroup, radioItemA11y } from '@/components/ui/radio-group';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

/** Two detents: the account list at half height, then nearly full. */
const SHEET_SNAP_POINTS = ['50%', '90%'];

type ContextPickerSheetProps = {
  visible: boolean;
  /** Sheet heading; the radio group's accessible name. */
  title: string;
  /** Account rows followed by the Cancel row at `cancelButtonIndex`. */
  options: string[];
  cancelButtonIndex: number;
  /** The current account's row, or -1 when the persisted one is not listed. */
  currentIndex: number;
  onSelect: (index: number) => void;
  onClose: () => void;
};

/**
 * The account picker's bottom sheet. It draws the divider and the
 * current-account check from the app palette, and every account row exposes its
 * selection to a screen reader through `radioItemA11y`'s `checked` state (the
 * app's radio convention — see `ui/radio-group.tsx`). The library's action
 * sheet can do neither: its rows carry the option string as their only
 * accessible name, so the check would be colour-only, and its JS sheet
 * hardcodes a white surface that breaks in dark mode.
 */
export function ContextPickerSheet({
  visible,
  title,
  options,
  cancelButtonIndex,
  currentIndex,
  onSelect,
  onClose,
}: Readonly<ContextPickerSheetProps>) {
  // A hidden picker renders nothing (the app's modal-sheet convention): its
  // caller keeps it mounted for the lifetime of the composer, so building the
  // row tree on every render would cost the composer for nothing.
  if (!visible) {
    return null;
  }
  return (
    <ContextPickerSheetBody
      title={title}
      options={options}
      cancelButtonIndex={cancelButtonIndex}
      currentIndex={currentIndex}
      onSelect={onSelect}
      onClose={onClose}
    />
  );
}

function ContextPickerSheetBody({
  title,
  options,
  cancelButtonIndex,
  currentIndex,
  onSelect,
  onClose,
}: Readonly<Omit<ContextPickerSheetProps, 'visible'>>) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const cancelLabel = options[cancelButtonIndex] ?? '';

  return (
    <Sheet visible onClose={onClose} snapPoints={SHEET_SNAP_POINTS}>
      {/* The sheet fills the detent, so the row list takes the slack and
          scrolls: a long account list can never push Cancel off the bottom. */}
      <View className="flex-1" style={{ paddingBottom: insets.bottom + 12 }}>
        <Text
          accessibilityRole="header"
          className="px-3 py-3 text-center text-sm font-semibold text-muted-foreground"
        >
          {title}
        </Text>
        <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
          <RadioGroup label={title}>
            {options.map((label, index) => {
              if (index === cancelButtonIndex) {
                return null;
              }
              return (
                <Pressable
                  key={index}
                  className={cn(
                    'min-h-11 flex-row items-center gap-2 px-3 py-3 active:bg-secondary',
                    index < cancelButtonIndex && 'border-b-[0.5px] border-hair-soft'
                  )}
                  onPress={() => {
                    onSelect(index);
                  }}
                  {...radioItemA11y({ label, checked: index === currentIndex })}
                >
                  {/* Every account row holds the same blank gutter so the
                      labels line up; only the current account paints a check
                      in it. */}
                  <View className="w-4 items-center">
                    {index === currentIndex && <Check size={16} color={colors.primary} />}
                  </View>
                  <Text className="min-w-0 flex-1 text-sm" numberOfLines={1}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </RadioGroup>
        </ScrollView>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={cancelLabel}
          className="mt-1 min-h-11 items-center justify-center px-4 py-3 active:bg-secondary"
          onPress={() => {
            onSelect(cancelButtonIndex);
          }}
        >
          <Text className="text-sm font-medium text-foreground">{cancelLabel}</Text>
        </Pressable>
      </View>
    </Sheet>
  );
}
