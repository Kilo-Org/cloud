import { useRef } from 'react';
import { Pressable, ScrollView, type ScrollViewInstance, View } from 'react-native';

import { PickerSheet } from '@/components/picker-sheet';
import { Check } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type AccountPickerRow } from '@/lib/picker-bridge';
import { cn } from '@/lib/utils';

/**
 * The account picker's body: one action row per account, a check on the one the
 * reader is on, and the sheet's own Done as the only dismissal. Presented by the
 * `account-picker` route inside the app's standard native formSheet.
 *
 * Personal is the first row and the memberships follow in list order. A shown
 * membership that the list no longer holds marks nothing, so the check never
 * names an account the reader is not on.
 */
export function AccountPickerSheet({
  title,
  rows,
  shownOrganizationId,
  onSelect,
  onClose,
}: Readonly<{
  title: string;
  rows: readonly AccountPickerRow[];
  shownOrganizationId: string | null;
  onSelect: (organizationId: string | null) => void;
  onClose: () => void;
}>) {
  const colors = useThemeColors();
  const currentIndex =
    shownOrganizationId === null
      ? 0
      : rows.findIndex(row => row.organizationId === shownOrganizationId);
  const listRef = useRef<ScrollViewInstance>(null);
  // The list's own height, read from layout: the sheet body is the viewport.
  const viewportRef = useRef(0);
  // The checked row can begin below the fold once a reader holds many
  // memberships, and the sheet would then open with no visible mark on the
  // account they are on. Reveal the check once, when its row is laid out, and
  // only when the row runs past the fold: a row that already fits needs no
  // scroll, and scrolling it would hide the rows above it — personal is first,
  // so the sheet would open showing only organizations. The reveal stops at the
  // checked row's bottom edge, so the rows above it keep as much of the list as
  // their own height allows. A later layout (rotation) must not yank a list the
  // reader has scrolled.
  const revealed = useRef(false);

  return (
    <PickerSheet title={title} onDone={onClose} scrollable={false} topInset="never">
      <ScrollView
        ref={listRef}
        nestedScrollEnabled
        className="bg-background"
        showsVerticalScrollIndicator={false}
        onLayout={event => {
          viewportRef.current = event.nativeEvent.layout.height;
        }}
      >
        {rows.map((row, index) => (
          <Pressable
            key={row.organizationId ?? 'personal'}
            className={cn(
              ROW_TARGET_CLASS,
              'flex-row items-center gap-2 px-4 py-3 active:bg-secondary',
              index < rows.length - 1 && 'border-b border-hair-soft'
            )}
            onPress={() => {
              onSelect(row.organizationId);
            }}
            onLayout={
              index === currentIndex
                ? event => {
                    if (revealed.current) {
                      return;
                    }
                    revealed.current = true;
                    const { y, height } = event.nativeEvent.layout;
                    const viewport = viewportRef.current;
                    if (viewport <= 0 || y + height <= viewport) {
                      return;
                    }
                    listRef.current?.scrollTo({ y: y + height - viewport, animated: false });
                  }
                : undefined
            }
            accessible
            accessibilityRole="button"
            accessibilityLabel={row.label}
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
              {row.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </PickerSheet>
  );
}