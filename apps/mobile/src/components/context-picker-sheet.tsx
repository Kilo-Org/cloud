import { Check } from '@/components/ui/icons';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, type ScrollViewInstance, View } from 'react-native';

import { PickerSheet } from '@/components/picker-sheet';
import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type ContextPickerSheetProps = {
  /** Sheet heading, shown in the standard picker header above the rows. */
  title: string;
  /** Account rows in list order; a row's index is its selection index. */
  options: string[];
  /** The current account's row, or -1 when the persisted one is not listed. */
  currentIndex: number;
  onSelect: (index: number) => void;
  onDone: () => void;
  /** Set when the caller's bridge is gone — renders the "Options expired" shell. */
  expired?: boolean;
};

/**
 * The account picker as a `formSheet` route body. The route owns the
 * presentation and Android Back: a sheet presented as a screen is the top
 * native screen as soon as it is pushed, so Back dismisses this picker and
 * leaves the screen that opened it in place, which an imperative native sheet
 * could not do inside its opening animation.
 *
 * The rows are the account list itself: every row is an action button whose
 * selected state parallels the visible check, so the account choice is
 * available beyond color. A pick commits the account and closes the route.
 */
export function ContextPickerSheet({
  title,
  options,
  currentIndex,
  onSelect,
  onDone,
  expired = false,
}: Readonly<ContextPickerSheetProps>) {
  const colors = useThemeColors();
  const listRef = useRef<ScrollViewInstance>(null);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [checkedRow, setCheckedRow] = useState<{ y: number; height: number } | null>(null);
  const revealed = useRef(false);

  // A long membership list starts at the top, so the checked row can begin
  // below the fold: the sheet would open with no visible mark on the account
  // the user is on, and the first row is the only one left to read as the
  // selection. Reveal the check once, when its row is measured, and only when
  // the row runs past the fold: a row that already fits needs no scroll, and
  // scrolling it would hide the rows above it — the first row is the personal
  // account, so the sheet would open showing only organizations. The reveal
  // stops at the checked row's bottom edge, so the rows above it keep as much
  // of the list as their own height allows. A later layout (resize, rotation)
  // must not yank a list the user has scrolled.
  useEffect(() => {
    if (revealed.current || checkedRow === null || viewportHeight <= 0) {
      return;
    }
    revealed.current = true;
    const rowBottom = checkedRow.y + checkedRow.height;
    if (rowBottom <= viewportHeight) {
      return;
    }
    listRef.current?.scrollTo({ y: rowBottom - viewportHeight, animated: false });
  }, [checkedRow, viewportHeight]);

  if (expired) {
    return <PickerSheet title={title} onDone={onDone} scrollable={false} expired />;
  }

  const lastRowIndex = options.length - 1;

  return (
    <PickerSheet title={title} onDone={onDone} scrollable={false}>
      {/* The list is the sheet's own scroll view, so it measures its viewport
          itself: `flex-1` keeps it inside the presenter's height on both
          platforms, and the reveal above reads the height it reports. */}
      <ScrollView
        ref={listRef}
        className="flex-1"
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
        onLayout={event => {
          setViewportHeight(event.nativeEvent.layout.height);
        }}
      >
        {options.map((label, index) => (
          <Pressable
            key={index}
            className={cn(
              ROW_TARGET_CLASS,
              'flex-row items-center gap-2 px-4 py-3 active:bg-secondary',
              index !== lastRowIndex && 'border-b-[0.5px] border-hair-soft'
            )}
            onPress={() => {
              onSelect(index);
            }}
            onLayout={
              index === currentIndex
                ? event => {
                    const { y, height } = event.nativeEvent.layout;
                    setCheckedRow({ y, height });
                  }
                : undefined
            }
            accessible
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ selected: index === currentIndex }}
          >
            {/* Every account row holds the same blank gutter so the labels line
                up; only the current account paints a check in it. The gutter is
                the check's own 16 dp — the app's rem is 14, so `w-4` would clip
                the icon. */}
            <View className="w-[16px] items-center">
              {index === currentIndex && <Check size={16} color={colors.primary} />}
            </View>
            {/* The tail, not the leading words, tells sibling memberships
              apart, so a label cut at the row's width keeps its own name. */}
            <Text className="min-w-0 flex-1 text-sm" numberOfLines={1} ellipsizeMode="middle">
              {label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </PickerSheet>
  );
}