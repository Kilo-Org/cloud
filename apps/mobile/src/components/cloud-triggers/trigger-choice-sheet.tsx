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
import { ScrollView } from 'react-native';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import { SheetHeader } from '@/components/sheet-header';
import { ChoiceRow } from '@/components/ui/choice-row';
import { RowGroup } from '@/components/ui/row-group';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { useDetailScreenBottomPadding } from '@/lib/screen-insets';

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
  const bottomPadding = useDetailScreenBottomPadding();
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
        contentContainerClassName={SCREEN_BODY_CLASS}
        contentContainerStyle={{ paddingBottom: bottomPadding }}
        showsVerticalScrollIndicator={false}
      >
        <RowGroup>
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
            />
          ))}
        </RowGroup>
      </ScrollView>
    </SessionPageSheet>
  );
}
