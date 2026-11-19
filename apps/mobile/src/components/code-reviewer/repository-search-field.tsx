import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SearchField } from '@/components/ui/search-field';

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
  const [hasText, setHasText] = useState(false);

  const handleChangeText = useCallback(
    (text: string) => {
      setHasText(text !== '');
      onChangeText(text);
    },
    [onChangeText]
  );

  return (
    <SearchField
      className="mt-4"
      accessibilityLabel={t('agentChat.repoPicker.searchLabel')}
      placeholder={t('agentChat.repoPicker.searchPlaceholder')}
      hasText={hasText}
      onChangeText={handleChangeText}
    />
  );
}
