import { type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { type TextInput } from 'react-native';

import { SearchField } from '@/components/ui/search-field';

type LanguageSearchFieldProps = {
  editable: boolean;
  hasText: boolean;
  inputRef: RefObject<TextInput | null>;
  draftRef: RefObject<string>;
  onChangeText: (text: string) => void;
};

/**
 * The language picker's search field, the shared `SearchField`. Pinned under
 * the title row in a window tall enough for it plus a result row; the list
 * header otherwise. Extracted to keep the sheet within its max-lines budget.
 */
export function LanguageSearchField({
  editable,
  hasText,
  inputRef,
  draftRef,
  onChangeText,
}: LanguageSearchFieldProps) {
  const { t } = useTranslation();

  return (
    <SearchField
      inputRef={inputRef}
      // The field keeps the page gutter in both places: pinned under the title
      // row and as the list header, where the rows carry the same gutter
      // themselves, so a short window no longer moves it to the edge.
      className="mx-4 my-3"
      placeholder={t('language.search')}
      hasText={hasText}
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
      editable={editable}
    />
  );
}
