import { Search, X } from 'lucide-react-native';
import { type RefObject, useCallback } from 'react';
import { ActivityIndicator, Pressable, TextInput, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * Module-level anchor ref for the Agents search input. The screen owns the
 * uncontrolled TextInput ref (the `inputRef` prop); this shared ref mirrors
 * the same node so the session-list content can restore
 * assistive-technology focus after a session deletion without new screen
 * plumbing. It stays null while the header is unmounted (for example after
 * the last session is deleted), where `moveA11yFocus` no-ops safely.
 */
export const sessionListSearchInputA11yRef: RefObject<TextInput | null> = { current: null };

type SessionListSearchHeaderProps = {
  inputRef: RefObject<TextInput | null>;
  /** Drives the in-field X's visibility. Derived from `onChangeText` by the
   * parent so the TextInput itself stays uncontrolled (iOS TextInput rules). */
  hasText: boolean;
  showSearchBusy: boolean;
  showInlineError: boolean;
  onChangeText: (text: string) => void;
  onClearSearch: () => void;
};

export function SessionListSearchHeader({
  inputRef,
  hasText,
  showSearchBusy,
  showInlineError,
  onChangeText,
  onClearSearch,
}: Readonly<SessionListSearchHeaderProps>) {
  const colors = useThemeColors();
  // Attach the screen's uncontrolled ref AND the shared deletion anchor to
  // the same TextInput node. The screen's ref identity is stable (a useRef
  // from `useSessionSearchInput`), so the callback ref stays stable too.
  const attachInputRef = useCallback(
    (node: TextInput | null) => {
      inputRef.current = node;
      sessionListSearchInputA11yRef.current = node;
    },
    [inputRef]
  );
  return (
    <View>
      <View className="mx-[22px] mb-[14px] mt-3 flex-row items-center gap-2 rounded-[10px] border border-border bg-card px-4 py-1.5">
        {/* Fixed-size slot: the spinner swaps in for the icon, so the row never reflows. */}
        <View className="h-[18px] w-[18px] items-center justify-center">
          {showSearchBusy ? (
            <ActivityIndicator
              size="small"
              color={colors.mutedForeground}
              accessibilityLabel="Searching"
            />
          ) : (
            <Search size={18} color={colors.mutedForeground} />
          )}
        </View>
        <TextInput
          ref={attachInputRef}
          accessibilityLabel="Search sessions"
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
      {showInlineError ? (
        <Text variant="muted" className="mx-[22px] mb-[14px] text-xs">
          Couldn't refresh. Pull down to try again.
        </Text>
      ) : null}
    </View>
  );
}
