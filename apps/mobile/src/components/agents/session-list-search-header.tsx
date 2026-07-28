import { Search, X } from 'lucide-react-native';
import { type RefObject } from 'react';
import { ActivityIndicator, Pressable, TextInput, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type SessionListSearchHeaderProps = {
  inputRef: RefObject<TextInput | null>;
  /** Drives the in-field X's visibility. Derived from `onChangeText` by the
   * parent so the TextInput itself stays uncontrolled (iOS TextInput rules). */
  hasText: boolean;
  isSearchPending: boolean;
  showInlineError: boolean;
  onChangeText: (text: string) => void;
  onClearSearch: () => void;
};

export function SessionListSearchHeader({
  inputRef,
  hasText,
  isSearchPending,
  showInlineError,
  onChangeText,
  onClearSearch,
}: Readonly<SessionListSearchHeaderProps>) {
  const colors = useThemeColors();
  return (
    <View>
      <View className="mx-[22px] mb-[14px] mt-3 flex-row items-center gap-2 rounded-[10px] border border-border bg-card px-4 py-1.5">
        <Search size={18} color={colors.mutedForeground} />
        <TextInput
          ref={inputRef}
          className="min-h-6 flex-1 py-1 text-[15px] leading-6 text-foreground"
          placeholder="Search sessions..."
          placeholderTextColor={colors.mutedForeground}
          onChangeText={onChangeText}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
        />
        {hasText ? (
          <Pressable
            onPress={onClearSearch}
            accessibilityLabel="Clear search"
            accessibilityRole="button"
            hitSlop={12}
            className="active:opacity-70"
          >
            <X size={16} color={colors.mutedForeground} />
          </Pressable>
        ) : null}
      </View>
      {isSearchPending ? (
        <View className="mx-[22px] mb-[14px] flex-row items-center gap-2">
          <ActivityIndicator size="small" color={colors.mutedForeground} />
          <Text variant="muted" className="text-xs">
            Searching…
          </Text>
        </View>
      ) : null}
      {showInlineError ? (
        <Text variant="muted" className="mx-[22px] mb-[14px] text-xs">
          Couldn't refresh. Pull down to try again.
        </Text>
      ) : null}
    </View>
  );
}
