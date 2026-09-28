import { Check } from '@/components/ui/icons';
import { Modal, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RadioGroup, radioItemA11y } from '@/components/ui/radio-group';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

/** Gap kept between the sheet and the window edges. */
const SHEET_EDGE_MARGIN = 16;

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
 * The account picker's own bottom sheet. It draws the divider and the
 * current-account check from the app palette, and every account row exposes its
 * selection to a screen reader through `radioItemA11y`'s `checked` state (the
 * app's radio convention — see `ui/radio-group.tsx`). The library's action
 * sheet can do neither: its rows carry the option string as their only
 * accessible name, so the check would be colour-only, and its JS sheet
 * hardcodes a white surface that breaks in dark mode.
 */
export function ContextPickerSheet(props: Readonly<ContextPickerSheetProps>) {
  // Mount the sheet's body only while it is open (the app's modal-sheet
  // convention: a hidden sheet renders nothing, so a closed picker measures no
  // window and mounts no modal).
  if (!props.visible) {
    return null;
  }
  return <ContextPickerSheetBody {...props} />;
}

function ContextPickerSheetBody({
  title,
  options,
  cancelButtonIndex,
  currentIndex,
  onSelect,
  onClose,
}: Readonly<ContextPickerSheetProps>) {
  const colors = useThemeColors();
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const cancelLabel = options[cancelButtonIndex] ?? '';
  // Yoga resolves vertical percentage padding against the parent's WIDTH, so a
  // percentage cap grows with the screen width and pushes the sheet past the top
  // of a short (landscape) window. Cap it to the window minus the safe areas
  // instead: the row list then scrolls inside the sheet and Cancel stays visible.
  const sheetMaxHeight = Math.max(
    0,
    windowHeight - insets.top - insets.bottom - SHEET_EDGE_MARGIN * 2
  );

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        // Backdrop tap-to-dismiss. accessible={false} so it doesn't collapse the
        // whole sheet subtree into a single VoiceOver node (Pressable defaults to
        // accessible=true) — the rows below stay individually navigable.
        accessible={false}
        className="flex-1 justify-end"
        style={{ paddingTop: insets.top + SHEET_EDGE_MARGIN }}
        onPress={onClose}
      >
        <View className="absolute inset-0 bg-black opacity-50" />
        <Pressable
          // Catches taps to stop backdrop dismissal; accessible={false} so the
          // rows and Cancel stay individually navigable.
          accessible={false}
          className="max-h-[80%] rounded-t-3xl bg-card pt-2"
          style={{ maxHeight: sheetMaxHeight, paddingBottom: insets.bottom + 12 }}
          onPress={event => {
            event.stopPropagation();
          }}
        >
          <Text
            accessibilityRole="header"
            className="px-3 py-3 text-center text-sm font-semibold text-muted-foreground"
          >
            {title}
          </Text>
          <ScrollView className="shrink" showsVerticalScrollIndicator={false}>
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
        </Pressable>
      </Pressable>
    </Modal>
  );
}
