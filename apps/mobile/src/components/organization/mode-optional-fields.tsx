import { useTranslation } from 'react-i18next';

import { orgCopy } from '@/components/organization/org-customization-copy';
import { FormField } from '@/components/ui/form-field';

/** The three optional prose fields a mode carries. */
type ModeOptionalField = 'description' | 'whenToUse' | 'customInstructions';

type ModeOptionalFieldsProps = Readonly<{
  description: string;
  whenToUse: string;
  customInstructions: string;
  disabled: boolean;
  onChange: (field: ModeOptionalField, value: string) => void;
}>;

/**
 * The mode's optional prose: what it does, when a person should reach for it, and
 * the instructions it adds to its role definition. All three are free text the
 * server stores as written, so the fields stay uncontrolled and report every
 * change.
 */
export function ModeOptionalFields({
  description,
  whenToUse,
  customInstructions,
  disabled,
  onChange,
}: ModeOptionalFieldsProps) {
  const { t } = useTranslation();
  return (
    <>
      <FormField
        label={orgCopy(t, 'modesDescriptionLabel')}
        defaultValue={description}
        disabled={disabled}
        onChangeText={value => {
          onChange('description', value);
        }}
      />
      <FormField
        label={orgCopy(t, 'modesWhenToUseLabel')}
        defaultValue={whenToUse}
        multiline
        textAlignVertical="top"
        className="min-h-20 leading-[1.25rem]"
        disabled={disabled}
        onChangeText={value => {
          onChange('whenToUse', value);
        }}
      />
      <FormField
        label={orgCopy(t, 'modesInstructionsLabel')}
        defaultValue={customInstructions}
        multiline
        textAlignVertical="top"
        className="min-h-32 leading-[1.25rem]"
        disabled={disabled}
        onChangeText={value => {
          onChange('customInstructions', value);
        }}
      />
    </>
  );
}
