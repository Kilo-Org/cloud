import { type RefObject, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type TextInput } from 'react-native';

import { SearchField } from '@/components/ui/search-field';

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
  return (
    <SearchField
      className="mx-4 my-2"
      inputRef={search.inputRef}
      placeholder={t('modelChat.catalog.search')}
      hasText={search.hasText}
      onChangeText={search.handleChangeText}
      onClear={search.handleClear}
    />
  );
}
