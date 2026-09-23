import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ChoiceRow } from '@/components/ui/choice-row';
import { Text } from '@/components/ui/text';
import { type LanguagePickerItem } from '@/i18n/language-rows';
import { type LanguagePreference } from '@/lib/hooks/use-language-preference';
import { cn } from '@/lib/utils';

type LanguagePickerRowProps = Readonly<{
  item: LanguagePickerItem;
  /** True for the first entry of the list: its group title needs no top gap. */
  first: boolean;
  /** A group title never carries the divider of the row above it. */
  showDivider: boolean;
  selected: LanguagePreference;
  disabled: boolean;
  /** The device's own language, shown under the device option. */
  deviceEndonym: string;
  /** Direction of the interface, not of the row's own language. */
  isRtl: boolean;
  onSelect: (preference: LanguagePreference) => void;
}>;

export function LanguagePickerRow({
  item,
  first,
  showDivider,
  selected,
  disabled,
  deviceEndonym,
  isRtl,
  onSelect,
}: LanguagePickerRowProps) {
  const { t } = useTranslation();
  const dividerClass = showDivider ? 'border-b-[0.5px] border-hair-soft' : undefined;
  const textClass = `flex-1 ${isRtl ? 'pl-3' : 'pr-3'}`;
  // iOS resolves `textAlign: 'auto'` from the paragraph's first strong
  // character, so an Arabic endonym right-aligns itself inside an LTR
  // interface while its Latin subtitle stays left — the two lines of one row
  // then do not share an edge. Naming the physical start edge in LTR keeps
  // them together. RTL needs no counterpart: `@/components/ui/text` names the
  // paragraph direction there, and React Native swaps a physical `text-left`
  // under an RTL layout, which would float it to the wrong edge.
  const alignClass = isRtl ? undefined : 'text-left';

  if (item.kind === 'section') {
    return (
      <Text
        variant="small"
        className={`uppercase tracking-wide text-muted-foreground ${first ? 'pb-2 pt-1' : 'pb-2 pt-6'}`}
      >
        {t(item.section === 'current' ? 'language.current' : 'language.allLanguages')}
      </Text>
    );
  }

  if (item.kind === 'device') {
    return (
      <ChoiceRow
        className={dividerClass}
        selected={selected === 'device'}
        disabled={disabled}
        onPress={() => {
          onSelect('device');
        }}
      >
        <View className={textClass}>
          <Text className={cn('text-sm font-medium', alignClass)}>
            {t('language.deviceLanguage')}
          </Text>
          <Text variant="muted" className={cn('mt-0.5 text-xs', alignClass)}>
            {deviceEndonym}
          </Text>
        </View>
      </ChoiceRow>
    );
  }

  return (
    <ChoiceRow
      className={dividerClass}
      selected={selected === item.row.tag}
      disabled={disabled}
      onPress={() => {
        onSelect(item.row.tag);
      }}
    >
      <View className={textClass}>
        {/* Both lines follow the interface's direction, not each row's own:
            a Latin name under a right-aligned row must not jump to the left
            edge. Unicode bidi already renders each script correctly inside
            the line. */}
        <Text className={cn('text-sm font-medium', alignClass)}>{item.row.endonym}</Text>
        <Text variant="muted" className={cn('mt-0.5 text-xs', alignClass)}>
          {item.row.englishName}
        </Text>
      </View>
    </ChoiceRow>
  );
}
