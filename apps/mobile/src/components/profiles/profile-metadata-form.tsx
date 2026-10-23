import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import { validateProfileDescription, validateProfileName } from '@/lib/agent-profile-forms';
import { type AgentProfileDetail } from '@/lib/hooks/use-agent-profiles';

type MetadataFormProps = Readonly<{
  profile: AgentProfileDetail;
  isSaving: boolean;
  onSave: (values: { name: string; description: string }) => Promise<boolean>;
}>;

/**
 * Uncontrolled metadata form, remounted via `metadataFormKey` only when server
 * metadata changes. Defaults follow the draft refs so pending/error renders
 * cannot restore the old server values in the native fields.
 */
export function ProfileMetadataForm({ profile, isSaving, onSave }: MetadataFormProps) {
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
      <FormField
        label={t('profiles.nameLabel')}
        placeholder={t('profiles.namePlaceholder')}
        defaultValue={nameRef.current}
        error={nameError ?? undefined}
        disabled={isSaving}
        required
        returnKeyType="next"
        onChangeText={value => {
          nameRef.current = value;
          if (nameError !== null && validateProfileName(value) === null) {
            setNameError(null);
          }
        }}
      />
      <FormField
        label={t('profiles.descriptionLabel')}
        placeholder={t('profiles.descriptionPlaceholder')}
        defaultValue={descriptionRef.current}
        error={descriptionError ?? undefined}
        multiline
        textAlignVertical="top"
        className="min-h-20 leading-5"
        disabled={isSaving}
        onChangeText={value => {
          descriptionRef.current = value;
          if (descriptionError !== null && validateProfileDescription(value) === null) {
            setDescriptionError(null);
          }
        }}
      />
      {saveFailed ? <AccessibleStatus message={t('profiles.saveFailed')} /> : null}
      <Button loading={isSaving} disabled={isSaving} onPress={submit}>
        <Text>{t(saveFailed ? 'common.retry' : 'common.save')}</Text>
      </Button>
    </View>
  );
}
