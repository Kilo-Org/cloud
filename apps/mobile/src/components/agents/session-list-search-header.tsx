import { Search, X } from '@/components/ui/icons';
import { type RefObject, useMemo } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import {
  hitSlopPerSide,
  MIN_TAP_TARGET_CLASS,
  MIN_TAP_TARGET_DP,
  TOUCH_TARGET_DP,
} from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

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
        className="my-2 flex-row items-center gap-2 rounded-[10px] border border-border bg-card px-4 py-1.5"
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
          placeholder={t('agents.search.searchSessionsPlaceholder')}
          placeholderTextColor={colors.mutedForeground}
          onChangeText={onChangeText}
          defaultValue={defaultValue}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
        />
        {hasText ? (
          <Pressable
            onPress={onClearSearch}
            accessibilityLabel={t('common.clearSearch')}
            accessibilityRole="button"
            // The icon sits in a 28dp box so the control's own accessibility node
            // is at least 28dp; the slop tops the touch region up to 44pt.
            hitSlop={hitSlopPerSide(MIN_TAP_TARGET_DP, TOUCH_TARGET_DP)}
            className={cn('active:opacity-70', MIN_TAP_TARGET_CLASS)}
          >
            <X size={16} color={colors.mutedForeground} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
