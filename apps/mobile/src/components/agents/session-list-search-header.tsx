import { Search, X } from '@/components/ui/icons';
import { type RefObject, useMemo } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { COMPACT_CONTROL_HIT_SLOP_DP } from '@/lib/a11y/touch-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

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
      <View
        style={fieldMargins}
        // `min-h-[44px]`: the field reserves the X's target height, so the
        // field never grows when the first keystroke reveals that button.
        className="my-2 min-h-[44px] flex-row items-center gap-2 rounded-[10px] border border-border bg-card px-4"
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
            // The frame, not the 16pt glyph, is what the size audit measures:
            // `h-11 w-11` is 38.5pt on device and the 3pt slop carries it to
            // the 44pt minimum. `-mr-2` keeps the glyph near its old inset and
            // the frame's left edge inside the field's right padding.
            hitSlop={COMPACT_CONTROL_HIT_SLOP_DP}
            className="-mr-2 h-11 w-11 items-center justify-center active:opacity-70"
          >
            <X size={16} color={colors.mutedForeground} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
