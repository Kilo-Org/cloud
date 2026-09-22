import { Search, X } from '@/components/ui/icons';
import { type RefObject, useMemo } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { COMPACT_CONTROL_HIT_SLOP_DP } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

// The row's `gap-2` compiles to 7pt, not 8pt: NativeWind v5 fixes 1rem at
// 14pt. The clear control's left slop is capped at that gap, so its touch
// region meets the input's instead of covering it — the same cap
// `session-list-header-actions.tsx` applies to the two header controls facing
// each other. 38 + 8 + 7 = 53pt across and 38 + 8 + 8 = 54pt down both clear
// the 44pt target.
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
  defaultValue,
  inputKey,
}: Readonly<SessionListSearchHeaderProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  // The landscape side insets keep the field's rounded border and left tap
  // area clear of the sensor housing; portrait insets are 0, keeping the
  // fixed 22px margin unchanged.
  const { left, right } = useSafeAreaInsets();
  const fieldMargins = useMemo(
    () => ({ marginLeft: 22 + left, marginRight: 22 + right }),
    [left, right]
  );
  return (
    <View>
      {/* One `min-height` floor, not two: `min-h-[51px]` is the height the row
          must already hold for the clear control's 38pt box plus the field's
          own 10.5pt vertical padding (`py-1.5` is 0.375rem at the app's 14pt
          rem) and its 2pt vertical `border` (1pt a side, inside the border box
          React Native lays out), so the first keystroke cannot grow the row and
          shift the list below. A second `min-h-*` class would set the same
          property, leaving which floor wins to the order Tailwind emits its
          rules rather than to this intent. */}
      <View
        style={fieldMargins}
        className="my-2 min-h-[51px] flex-row items-center gap-2 rounded-[10px] border border-border bg-card px-4 py-1.5"
      >
        {/* Fixed-size slot: the spinner swaps in for the icon, so the row never reflows. */}
        <View className="h-[18px] w-[18px] items-center justify-center">
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
        <TextInput
          key={inputKey}
          ref={inputRef}
          accessibilityLabel={t('agents.search.searchSessions')}
          // Height comes from `min-h`, never `py`: iOS insets the already-centered
          // text rect by the padding and draws the placeholder low.
          className="min-h-[26px] flex-1 text-[15px] leading-[normal] text-foreground"
          // One line, always: at a narrow width with a large font scale the
          // placeholder wrapped inside the field and the field grew with it.
          numberOfLines={1}
          placeholder={t('agents.search.searchSessionsPlaceholder')}
          placeholderTextColor={colors.mutedForeground}
          onChangeText={onChangeText}
          defaultValue={defaultValue}
          returnKeyType="search"
          // Android's IME, with little room left in a landscape window, swaps
          // the app for its own full-screen extract editor: the capture that
          // filed this defect (e9-land-ime-up.png) shows the IME's editor —
          // the query, a SEARCH action button and the keyboard — where the
          // screen's own no-match body belongs. `disableFullscreenUI` maps to
          // `EditorInfo.IME_FLAG_NO_FULLSCREEN` (ReactEditText.updateImeOptions),
          // the flag the IME's fullscreen decision reads, so the input is
          // edited in place and the screen's own body and the tab bar stay on
          // screen. The screen's insets then reserve the IME's occlusion (see
          // `useAgentsBottomBands`).
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
            // One size, spelled as whole pixels the mounted test compiles: the
            // 38pt box clears the 28dp floor, and the shared 8pt slop carries the
            // reach past the 44pt target rather than onto it, because
            // `@/lib/a11y/tap-target` records a 44dp target measuring 43.81dp at
            // density 420. The row's `min-h-[51px]` already holds this box plus
            // the field's 10.5pt padding and 2pt border. A second `h-*`/`w-*`
            // pair here would set the same properties and leave the real size to
            // Tailwind's emit order. `-mr-2` keeps the glyph near its old inset
            // and the frame's left edge inside the field's right padding.
            hitSlop={CLEAR_HIT_SLOP}
            className="-mr-2 h-[38px] w-[38px] items-center justify-center active:opacity-70"
          >
            <X size={16} color={colors.mutedForeground} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
