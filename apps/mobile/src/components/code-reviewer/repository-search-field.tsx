import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, type TextInput, View } from 'react-native';

import { Search, X } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import {
  COMPACT_CONTROL_BOX_CLASS,
  COMPACT_CONTROL_HIT_SLOP_DP,
  FIELD_TRIGGER_BODY_CLASS,
  FIELD_TRIGGER_FRAME_CLASS,
} from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

/**
 * The query box above a repository list, for a snapshot long enough that
 * scrolling is not a way to find one row.
 *
 * The field is uncontrolled, as every single-line input here is: the typed text
 * lives in the native field, and the parent receives it through `onChangeText`
 * only to filter the rows. `hasText` is derived UI (the in-field clear), never
 * the field's value. Clearing empties the native text and reports the empty
 * query, so the list the reader started from comes back.
 */
export function RepositorySearchField({
  onChangeText,
}: Readonly<{ onChangeText: (query: string) => void }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const inputRef = useRef<TextInput>(null);
  const [hasText, setHasText] = useState(false);

  const handleChangeText = useCallback(
    (text: string) => {
      setHasText(text !== '');
      onChangeText(text);
    },
    [onChangeText]
  );

  const handleClear = useCallback(() => {
    inputRef.current?.clear();
    setHasText(false);
    onChangeText('');
  }, [onChangeText]);

  return (
    // The shared field frame supplies the box: the same 48dp body, border and
    // radius every field trigger in the app draws.
    <View className={cn('mt-4', FIELD_TRIGGER_FRAME_CLASS)}>
      <View className={FIELD_TRIGGER_BODY_CLASS}>
        <Search size={16} color={colors.mutedForeground} />
        <Input
          ref={inputRef}
          accessibilityLabel={t('agentChat.repoPicker.searchLabel')}
          placeholder={t('agentChat.repoPicker.searchPlaceholder')}
          // The row owns the inset on both sides, so the field itself adds none:
          // a physical inset here pushed the field past its box in right-to-left
          // layouts, where the row's children swap sides.
          className="flex-1 pl-0 pr-0 text-sm text-foreground"
          onChangeText={handleChangeText}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
          disableFullscreenUI
        />
        {hasText ? (
          <Pressable
            onPress={handleClear}
            accessibilityRole="button"
            accessibilityLabel={t('common.clearSearch')}
            hitSlop={COMPACT_CONTROL_HIT_SLOP_DP}
            className={cn(COMPACT_CONTROL_BOX_CLASS, 'active:opacity-70')}
          >
            <X size={16} color={colors.mutedForeground} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
