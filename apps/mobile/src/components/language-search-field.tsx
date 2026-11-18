import { type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { type TextInput, View } from 'react-native';

import { Search } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type LanguageSearchFieldProps = {
  searchInList: boolean;
  editable: boolean;
  inputRef: RefObject<TextInput | null>;
  draftRef: RefObject<string>;
  onChangeText: (text: string) => void;
};

/**
 * The language picker's search field: the filled pill with a leading
 * magnifier, the one search-field shape the repository and share pickers use.
 * Pinned under the title row in a window tall enough for it plus a result row;
 * the list header otherwise. The outlined box this replaced made the same
 * control look like two different controls across pickers. The field itself is
 * the shared single-line `Input`: it owns the height floor, the one line box
 * for the placeholder and the value, and the RTL content alignment, so the
 * pill owns only the chrome and this field keeps only its flex share and text
 * size.
 */
export function LanguageSearchField({
  searchInList,
  editable,
  inputRef,
  draftRef,
  onChangeText,
}: LanguageSearchFieldProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();

  return (
    <View
      className={cn(
        'mb-3 mt-3 flex-row items-center gap-2 rounded-full bg-secondary px-3 py-2',
        // As the list header the list's own content padding stands in for the
        // pinned side margin, so the field keeps its width and aligns with the
        // rows.
        searchInList ? 'mx-0' : 'mx-4'
      )}
    >
      <Search size={18} color={colors.mutedForeground} />
      <Input
        ref={inputRef}
        accessibilityLabel={t('language.search')}
        // The pill supplies the horizontal inset, so the field zeroes both
        // physical sides of the shared box.
        className="flex-1 pl-0 pr-0 text-base text-foreground"
        placeholder={t('language.search')}
        placeholderTextColor={colors.mutedForeground}
        // Uncontrolled: iOS drops keystrokes when state drives `value`. The
        // focus effect clears the live field through the ref, so a reopen
        // starts empty.
        onChangeText={text => {
          draftRef.current = text;
          onChangeText(text);
        }}
        // A resize that moves this field between the pinned header and the list
        // header mounts a new input; the draft then comes back with it.
        defaultValue={draftRef.current}
        autoCapitalize="none"
        autoCorrect={false}
        editable={editable}
        clearButtonMode="while-editing"
        returnKeyType="search"
      />
    </View>
  );
}
