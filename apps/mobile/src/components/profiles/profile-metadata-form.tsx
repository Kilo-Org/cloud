import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  ProfileDescriptionField,
  ProfileNameField,
} from '@/components/profiles/profile-bound-field';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { validateProfileDescription, validateProfileName } from '@/lib/agent-profile-forms';

type MetadataFormProps = Readonly<{
  /** Only the metadata the form edits: the Overview reads counts, not collections. */
  profile: { name: string; description: string | null };
  isSaving: boolean;
  onSave: (values: { name: string; description: string }) => Promise<boolean>;
  disabled?: boolean;
}>;

/**
 * Uncontrolled metadata form, remounted via `metadataFormKey` only when server
 * metadata changes. Defaults follow the draft refs so pending/error renders
 * cannot restore the old server values in the native fields.
 */
export function ProfileMetadataForm({
  profile,
  isSaving,
  onSave,
  disabled = false,
}: MetadataFormProps) {
  const { t } = useTranslation();
  const nameRef = useRef(profile.name);
  const descriptionRef = useRef(profile.description ?? '');
  const [nameError, setNameError] = useState<string | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);

  const submit = async () => {
    const name = nameRef.current.trim();
    const nameIssue = validateProfileName(name);
    if (nameIssue !== null) {
      setNameError(
        nameIssue === 'empty' ? t('profiles.nameRequired') : t('agentChat.newSession.nameTooLong')
      );
      return;
    }
    const description = descriptionRef.current.trim();
    if (validateProfileDescription(description) !== null) {
      setDescriptionError(t('agentChat.newSession.descriptionTooLong'));
      return;
    }
    setNameError(null);
    setDescriptionError(null);
    setSaveFailed(false);
    setSaveFailed(!(await onSave({ name, description })));
  };

  return (
    <View className="gap-4">
      <ProfileNameField
        defaultValue={nameRef.current}
        error={nameError ?? undefined}
        disabled={disabled || isSaving}
        onChangeText={value => {
          nameRef.current = value;
          if (nameError !== null && validateProfileName(value) === null) {
            setNameError(null);
          }
        }}
      />
      <ProfileDescriptionField
        defaultValue={descriptionRef.current}
        error={descriptionError ?? undefined}
        disabled={disabled || isSaving}
        onChangeText={value => {
          descriptionRef.current = value;
          if (descriptionError !== null && validateProfileDescription(value) === null) {
            setDescriptionError(null);
          }
        }}
      />
      {saveFailed ? <AccessibleStatus message={t('profiles.saveFailed')} /> : null}
      <Button loading={isSaving} disabled={disabled || isSaving} onPress={submit}>
        <Text>{t(saveFailed ? 'common.retry' : 'common.save')}</Text>
      </Button>
    </View>
  );
}
