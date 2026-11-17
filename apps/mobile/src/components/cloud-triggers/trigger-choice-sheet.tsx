/**
 * One selection sheet for the trigger form's own pickers: the agent, the
 * environment and the profile.
 *
 * A list here is short (an organization's environments or profiles), and the
 * selection is a tap, so this is a full-window sheet with the rows it has, not
 * the searchable repository picker. It reuses the app's `ChoiceRow`, so every row
 * carries the radio state a screen reader announces.
 */

import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import { SheetHeader } from '@/components/sheet-header';
import { ChoiceRow } from '@/components/ui/choice-row';

export type TriggerChoice = Readonly<{
  /** `null` is the sheet's "nothing chosen" row: no environment, no profile. */
  value: string | null;
  label: string;
  description?: string;
}>;

type TriggerChoiceSheetProps = Readonly<{
  visible: boolean;
  title: string;
  options: readonly TriggerChoice[];
  selected: string | null;
  onSelect: (value: string | null) => void;
  onClose: () => void;
}>;

export function TriggerChoiceSheet({
  visible,
  title,
  options,
  selected,
  onSelect,
  onClose,
}: TriggerChoiceSheetProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  return (
    <SessionPageSheet visible={visible} onClose={onClose}>
      <SheetHeader
        title={title}
        onDone={onClose}
        doneLabel={t('common.done')}
        topInset="ios-page-sheet"
      />
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-2 pb-4 pt-2"
        showsVerticalScrollIndicator={false}
      >
        {options.map(option => (
          <ChoiceRow
            key={option.value ?? '__default__'}
            label={option.label}
            description={option.description}
            selected={option.value === selected}
            onPress={() => {
              onSelect(option.value);
              onClose();
            }}
            className="px-2"
          />
        ))}
      </ScrollView>
      <View style={{ height: insets.bottom }} className="bg-background" />
    </SessionPageSheet>
  );
}
