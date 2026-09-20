import { Search, X } from '@/components/ui/icons';
import { type RefObject, useMemo } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * 36pt square + 4pt slop = the 44pt minimum target DESIGN.md asks for. The box
 * is a real layout size, not slop alone: the on-device explorer measures
 * laid-out bounds and `hitSlop` never widens them. `h-[36px]`, not `h-9` — the
 * app's native rem is 14pt, so `h-9` lays out at 31.5pt.
 */
const CLEAR_HIT_SLOP = 4;

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
      {/* `min-h-[50px]` reserves the clear control's 36pt box (36 + 6pt padding
          + 1pt border) so the first keystroke does not grow the row and shift
          the list below. */}
      <View
        style={fieldMargins}
        className="my-2 min-h-[50px] flex-row items-center gap-2 rounded-[10px] border border-border bg-card px-4 py-1.5"
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
            hitSlop={CLEAR_HIT_SLOP}
            className="h-[36px] w-[36px] items-center justify-center active:opacity-70"
          >
            <X size={16} color={colors.mutedForeground} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
