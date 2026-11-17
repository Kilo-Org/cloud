import { Search, X } from '@/components/ui/icons';
import { type RefObject } from 'react';
import { Pressable, type TextInput, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useTranslation } from 'react-i18next';

import { Input } from '@/components/ui/input';
import { COMPACT_CONTROL_HIT_SLOP_DP } from '@/lib/a11y/tap-target';
import { SCREEN_GUTTER_CLASS } from '@/lib/layout';
import { useSideInsetStyle } from '@/lib/screen-insets';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

// NativeWind's gap-2 is 7pt; cap the clear target's facing slop at that gap.
const CLEAR_HIT_SLOP = {
  top: COMPACT_CONTROL_HIT_SLOP_DP,
  bottom: COMPACT_CONTROL_HIT_SLOP_DP,
  right: COMPACT_CONTROL_HIT_SLOP_DP,
  left: 7,
};

type SessionListSearchHeaderProps = {
  inputRef: RefObject<TextInput | null>;
  /** Drives the in-field X's visibility. Derived from `onChangeText` by the
   * parent so the TextInput itself stays uncontrolled (iOS TextInput rules). */
  hasText: boolean;
  showSearchBusy: boolean;
  onChangeText: (text: string) => void;
  onClearSearch: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  /** The field sits inline in a header row, so it takes no gutter or vertical margin. */
  inline?: boolean;
  /** Initial content for the uncontrolled input, applied on a restore remount. */
  defaultValue?: string;
  /** Remount key: changes once when a stored non-empty draft is restored. */
  inputKey?: string;
};

export function SessionListSearchHeader({
  inputRef,
  hasText,
  showSearchBusy,
  onChangeText,
  onClearSearch,
  onFocus,
  onBlur,
  inline = false,
  defaultValue,
  inputKey,
}: Readonly<SessionListSearchHeaderProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  // The landscape side insets keep the field's rounded border and left tap
  // area clear of the sensor housing; portrait insets are 0, leaving only the
  // page gutter.
  const sideInsetStyle = useSideInsetStyle();
  return (
    <View className={inline ? 'min-w-0 flex-1' : undefined}>
      <View
        style={inline ? undefined : sideInsetStyle}
        className={cn(
          // The same field recipe `FormField` draws: the canvas fill, the input
          // border token and the control radius. The compact field sits in a
          // header row, so it carries the page gutter rather than a card.
          'flex-row items-center gap-2 rounded-md border border-input bg-background px-2',
          !inline && cn('my-2', SCREEN_GUTTER_CLASS)
        )}
      >
        {/* Fixed-size slot: the spinner swaps in for the icon, so the row never reflows. */}
        <View className="size-5 items-center justify-center">
          {showSearchBusy ? (
            <ActivityIndicator
              size="small"
              color={colors.mutedForeground}
              accessibilityLabel={t('agents.search.searching')}
            />
          ) : (
            <Search size={18} color={colors.mutedForeground} />
          )}
        </View>
        <Input
          key={inputKey}
          ref={inputRef}
          accessibilityLabel={t('agents.search.searchSessions')}
          // The shared box supplies the height (`min-h-[44px]`, never `py`: iOS
          // insets the already-centered text rect by padding and draws the
          // placeholder low) and the RTL content alignment, so this field keeps
          // only its own size and text size.
          className="flex-1 text-sm text-foreground"
          // One line, always: at a narrow width with a large font scale the
          // placeholder wrapped inside the field and the field grew with it.
          numberOfLines={1}
          placeholder={t('agents.search.searchSessionsPlaceholder')}
          placeholderTextColor={colors.mutedForeground}
          onChangeText={onChangeText}
          onFocus={onFocus}
          onBlur={onBlur}
          defaultValue={defaultValue}
          returnKeyType="search"
          // Keep Android landscape searches in the app instead of the IME's fullscreen editor.
          disableFullscreenUI
          autoCapitalize="none"
          autoCorrect={false}
        />
        {hasText ? (
          <Pressable
            onPress={onClearSearch}
            accessibilityLabel={t('common.clearSearch')}
            accessibilityRole="button"
            // The frame, not the 16pt glyph, is what the size audit measures.
            // One size, spelled as the spacing scale the mounted test compiles:
            // the 40pt box clears the 28dp floor, and the shared 8pt slop
            // carries the reach past the 44pt target rather than onto it,
            // because `@/lib/a11y/tap-target` records a 44dp target measuring
            // 43.81dp at density 420. The shared field's `min-h-[44px]` floor
            // already holds this box plus the input's border, so the control
            // never grows the row. A second `h-*`/`w-*` pair here would set the
            // same properties and leave the real size to Tailwind's emit order.
            // `-mr-2` keeps the glyph near its old inset and the frame's left
            // edge inside the field's right padding.
            hitSlop={CLEAR_HIT_SLOP}
            className="-mr-2 h-10 w-10 items-center justify-center active:opacity-70"
          >
            <X size={16} color={colors.mutedForeground} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
