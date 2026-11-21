import { type RefObject } from 'react';
import { type TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { SearchField } from '@/components/ui/search-field';
import { SCREEN_GUTTER_CLASS } from '@/lib/layout';
import { useSideInsetStyle } from '@/lib/screen-insets';
import { cn } from '@/lib/utils';

type SessionListSearchHeaderProps = {
  inputRef: RefObject<TextInput | null>;
  /** Drives the in-field X's visibility. Derived from `onChangeText` by the
   * parent so the TextInput itself stays uncontrolled (iOS TextInput rules). */
  hasText: boolean;
  showSearchBusy: boolean;
  onChangeText: (text: string) => void;
  onClearSearch: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  /** The field sits inline in a header row, so it takes no gutter or vertical margin. */
  inline?: boolean;
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
  onFocus,
  onBlur,
  inline = false,
  defaultValue,
  inputKey,
}: Readonly<SessionListSearchHeaderProps>) {
  const { t } = useTranslation();
  // The landscape side insets keep the field's rounded border and left tap
  // area clear of the sensor housing; portrait insets are 0, leaving only the
  // page gutter.
  const sideInsetStyle = useSideInsetStyle();
  const field = (
    <SearchField
      key={inputKey}
      inputRef={inputRef}
      accessibilityLabel={t('agents.search.searchSessions')}
      placeholder={t('agents.search.searchSessionsPlaceholder')}
      hasText={hasText}
      busy={showSearchBusy ? t('agents.search.searching') : undefined}
      onChangeText={onChangeText}
      onClear={onClearSearch}
      onFocus={onFocus}
      onBlur={onBlur}
      defaultValue={defaultValue}
    />
  );
  // The gutter and the landscape sensor insets sit outside the bordered field,
  // so the field keeps only its own inset and the page inset never becomes
  // padding inside it. The insets go on a wrapper outside the gutter: inline
  // padding on the gutter View would replace its `px-4` instead of adding to it.
  return (
    <View
      style={inline ? undefined : sideInsetStyle}
      className={inline ? 'min-w-0 flex-1' : undefined}
    >
      {inline ? field : <View className={cn('my-2', SCREEN_GUTTER_CLASS)}>{field}</View>}
    </View>
  );
}
