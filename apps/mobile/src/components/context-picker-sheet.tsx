import { Check } from '@/components/ui/icons';
import { useRef } from 'react';
import {
  Pressable,
  ScrollView,
  type ScrollViewInstance,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

/**
 * The share of the window the account list may fill before it scrolls. The
 * heading and Cancel keep their room at the sheet's own edges, so a long
 * membership list scrolls inside the list instead of pushing them off.
 */
const LIST_MAX_WINDOW_FRACTION = 0.5;

type ContextPickerSheetProps = {
  visible: boolean;
  /** Sheet heading, shown above the account rows. */
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
 * The account picker sheet draws its divider and current-account check from
 * the app palette. Each row is an action button whose selected state parallels
 * the visible check, so the account choice is available beyond color.
 *
 * The sheet sizes to its content rather than to a fixed detent: a detent sheet
 * hands its React content the window height on Android (`fitToContents` is off
 * whenever `snapPoints` are passed), so a list with flex slack overflowed the
 * frame and left the rows past the frame — and Cancel, which sits below the
 * list — outside the sheet. A content-sized sheet keeps the heading, the rows
 * and Cancel in the frame at any membership count, and the list scrolls once it
 * reaches `LIST_MAX_WINDOW_FRACTION` of the window.
 * A clipped, ruled viewport sits 10 dp below the heading so a partially scrolled
 * account row cannot read as part of the title.
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
  const { height: windowHeight } = useWindowDimensions();
  const cancelLabel = options[cancelButtonIndex] ?? '';
  const listRef = useRef<ScrollViewInstance>(null);
  const listViewportHeight = Math.round(windowHeight * LIST_MAX_WINDOW_FRACTION);
  // The list caps at half the window, so a long membership list starts at the
  // top and the checked row can begin below the fold: the sheet would open with
  // no visible mark on the account the user is on, and the first row is the
  // only one left to read as the selection. Reveal the check once, when its row
  // is laid out, and only when the row runs past the fold: a row that already
  // fits needs no scroll, and scrolling it would hide the rows above it — the
  // first row is the personal account, so the sheet would open showing only
  // organizations. The reveal stops at the checked row's bottom edge, so the
  // rows above it keep as much of the list as their own height allows. A later
  // layout (resize, rotation) must not yank a list the user has scrolled.
  const revealed = useRef(false);
  // Divider between rows only: the rule that closes the list belongs to the
  // action area below, not to the last row.
  let lastRowIndex = -1;
  for (const [index] of options.entries()) {
    if (index !== cancelButtonIndex) {
      lastRowIndex = index;
    }
  }

  return (
    <Sheet visible onClose={onClose}>
      {/* The sheet's own content stops at the safe area: the dismiss row is the
          last thing it draws, so nothing is left below it but the platform's
          navigation bar. */}
      <View style={{ paddingBottom: insets.bottom }}>
        <Text
          accessibilityRole="header"
          className="px-3 py-3 text-center text-sm font-semibold text-muted-foreground"
        >
          {title}
        </Text>
        <View className="mt-[10px] overflow-hidden border-t border-border">
          <ScrollView
            ref={listRef}
            nestedScrollEnabled
            style={{ maxHeight: listViewportHeight }}
            showsVerticalScrollIndicator={false}
          >
            {options.map((label, index) => {
              if (index === cancelButtonIndex) {
                return null;
              }
              return (
                <Pressable
                  key={index}
                  className={cn(
                    ROW_TARGET_CLASS,
                    'flex-row items-center gap-2 px-3 py-3 active:bg-secondary',
                    index !== lastRowIndex && 'border-b-[0.5px] border-hair-soft'
                  )}
                  onPress={() => {
                    onSelect(index);
                  }}
                  onLayout={
                    index === currentIndex
                      ? event => {
                          if (revealed.current) {
                            return;
                          }
                          revealed.current = true;
                          const { y, height } = event.nativeEvent.layout;
                          if (y + height <= listViewportHeight) {
                            return;
                          }
                          listRef.current?.scrollTo({
                            y: y + height - listViewportHeight,
                            animated: false,
                          });
                        }
                      : undefined
                  }
                  accessible
                  accessibilityRole="button"
                  accessibilityLabel={label}
                  accessibilityState={{ selected: index === currentIndex }}
                >
                  {/* Every account row holds the same blank gutter so the
                      labels line up; only the current account paints a check
                      in it. The gutter is the check's own 16 dp — the app's rem
                      is 14, so `w-4` would clip the icon. */}
                  <View className="w-[16px] items-center">
                    {index === currentIndex && <Check size={16} color={colors.primary} />}
                  </View>
                  {/* The tail, not the leading words, tells sibling memberships
                    apart, so a label cut at the row's width keeps its own name. */}
                  <Text className="min-w-0 flex-1 text-sm" numberOfLines={1} ellipsizeMode="middle">
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
        {/* The dismiss row is an action, not the next account: a full rule
            closes the scrolling list where the rows stop, and the row's own
            section padding keeps it off that rule. Without the rule a row the
            list cuts at that edge read as if the sheet continued into Cancel. */}
        <View className="border-t border-border">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={cancelLabel}
            className={cn(
              ROW_TARGET_CLASS,
              'items-center justify-center px-4 py-3 active:bg-secondary'
            )}
            onPress={() => {
              onSelect(cancelButtonIndex);
            }}
          >
            <Text className="text-sm font-medium text-foreground">{cancelLabel}</Text>
          </Pressable>
        </View>
      </View>
    </Sheet>
  );
}
