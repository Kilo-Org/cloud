import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  ProfileDescriptionField,
  ProfileNameField,
} from '@/components/profiles/profile-bound-field';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { validateProfileDescription } from '@/lib/agent-profile-forms';
import { useProfileNameField } from '@/lib/hooks/use-profile-name-field';

type SavedMetadata = Readonly<{ name: string; description: string }>;

function savedMetadata(profile: { name: string; description: string | null }): SavedMetadata {
  return { name: profile.name.trim(), description: (profile.description ?? '').trim() };
}

type MetadataFormProps = Readonly<{
  /** Only the metadata the form edits: the Overview reads counts, not collections. */
  profile: { name: string; description: string | null };
  isSaving: boolean;
  onSave: (values: { name: string; description: string }) => Promise<boolean>;
  /** Reports whether the fields differ from the saved profile, on every change. */
  onDirtyChange?: (dirty: boolean) => void;
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
  onDirtyChange,
  disabled = false,
}: MetadataFormProps) {
  const { t } = useTranslation();
  const nameField = useProfileNameField(profile.name);
  const descriptionRef = useRef(profile.description ?? '');
  // The values the server holds for the metadata this form edits. Trimmed the
  // way a submit trims, so whitespace the form would not send is not an edit.
  const savedRef = useRef<SavedMetadata>(savedMetadata(profile));
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);

  const reportDirty = () => {
    onDirtyChange?.(
      nameField.valueRef.current.trim() !== savedRef.current.name ||
        descriptionRef.current.trim() !== savedRef.current.description
    );
  };

  // A remount (the saved metadata changed) and an unmount both leave nothing
  // unsaved to guard, so the screen cannot keep a stale flag either way.
  useEffect(() => {
    onDirtyChange?.(false);
    return () => {
      onDirtyChange?.(false);
    };
  }, [onDirtyChange]);

  const submit = async () => {
    const name = nameField.commit();
    if (name === null) {
      return;
    }
    const description = descriptionRef.current.trim();
    if (validateProfileDescription(description) !== null) {
      setDescriptionError(t('agentChat.newSession.descriptionTooLong'));
      return;
    }
    setDescriptionError(null);
    setSaveFailed(false);
    const saved = await onSave({ name, description });
    if (saved) {
      savedRef.current = { name, description };
      onDirtyChange?.(false);
    }
    setSaveFailed(!saved);
  };

  return (
    <View className="gap-4">
      <ProfileNameField
        defaultValue={nameField.valueRef.current}
        error={nameField.error}
        disabled={disabled || isSaving}
        onChangeText={value => {
          nameField.handleChangeText(value);
          reportDirty();
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
          reportDirty();
        }}
      />
      {saveFailed ? <AccessibleStatus message={t('profiles.saveFailed')} /> : null}
      <Button loading={isSaving} disabled={disabled || isSaving} onPress={submit}>
        <Text>{t(saveFailed ? 'common.retry' : 'common.save')}</Text>
      </Button>
    </View>
  );
}
