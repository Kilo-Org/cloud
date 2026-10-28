import { type RefObject, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, type TextInput, View } from 'react-native';

import { Search, X } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { COMPACT_CONTROL_HIT_SLOP_DP } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

const SEARCH_DELAY_MS = 350;

type ModelSearch = {
  readonly inputRef: RefObject<TextInput | null>;
  readonly hasText: boolean;
  /** The trimmed text, applied once typing pauses. */
  readonly query: string;
  readonly handleChangeText: (text: string) => void;
  readonly handleClear: () => void;
};

/** The field stays uncontrolled; only the paused, trimmed text reaches the query. */
export function useModelSearch(): ModelSearch {
  const inputRef = useRef<TextInput>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [hasText, setHasText] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    []
  );
  return {
    inputRef,
    hasText,
    query,
    handleChangeText: (text: string) => {
      setHasText(text !== '');
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setQuery(text.trim());
      }, SEARCH_DELAY_MS);
    },
    handleClear: () => {
      clearTimeout(timer.current);
      inputRef.current?.clear();
      setHasText(false);
      setQuery('');
    },
  };
}

export function ModelSearchField({ search }: Readonly<{ search: ModelSearch }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  return (
    <View className="mx-[22px] my-2 min-h-[51px] flex-row items-center gap-2 rounded-[10px] border border-border bg-card px-4 py-1.5">
      <Search size={18} color={colors.mutedForeground} />
      <Input
        ref={search.inputRef}
        accessibilityLabel={t('modelChat.catalog.search')}
        className="flex-1 text-[15px] text-foreground"
        numberOfLines={1}
        placeholder={t('modelChat.catalog.search')}
        placeholderTextColor={colors.mutedForeground}
        onChangeText={search.handleChangeText}
        returnKeyType="search"
        disableFullscreenUI
        autoCapitalize="none"
        autoCorrect={false}
      />
      {search.hasText && (
        <Pressable
          onPress={search.handleClear}
          accessibilityLabel={t('common.clearSearch')}
          accessibilityRole="button"
          hitSlop={COMPACT_CONTROL_HIT_SLOP_DP}
          className="-mr-2 h-[38px] w-[38px] items-center justify-center active:opacity-70"
        >
          <X size={16} color={colors.mutedForeground} />
        </Pressable>
      )}
    </View>
  );
}
