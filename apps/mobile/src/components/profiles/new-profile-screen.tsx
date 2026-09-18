import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { toast } from 'sonner-native';

import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { ChoiceRow } from '@/components/ui/choice-row';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import { validateProfileName } from '@/lib/agent-profile-forms';
import { useAgentProfileMutations } from '@/lib/hooks/use-agent-profiles';
import { useOrganization } from '@/lib/organization-context';
import { getProfileOverviewPath } from '@/lib/profile-agent-navigation';

type ProfileOwnerChoice = 'personal' | 'organization';

/**
 * The mutation hook toasts `error.message`; this screen only supplies a
 * fallback when the server sent nothing readable.
 */
function hasUsableMessage(error: unknown): boolean {
  return error instanceof Error && error.message.trim().length > 0;
}

export function NewProfileScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { organizationId } = useOrganization();
  // No organization context on the hook: the owner choice below decides which
  // `organizationId` each create carries, so a personal create is never
  // rewritten to the selected organization.
  const { create } = useAgentProfileMutations();
  const nameRef = useRef('');
  const descriptionRef = useRef('');
  const [owner, setOwner] = useState<ProfileOwnerChoice>('personal');
  const [nameError, setNameError] = useState<string | null>(null);

  const submit = async () => {
    const name = nameRef.current.trim();
    if (validateProfileName(name) !== null) {
      setNameError(t('profiles.nameRequired'));
      return;
    }
    setNameError(null);

    const description = descriptionRef.current.trim();
    const ownerOrganizationId =
      organizationId != null && owner === 'organization' ? organizationId : undefined;
    try {
      const created = await create.mutateAsync({
        name,
        ...(description.length > 0 ? { description } : {}),
        ...(ownerOrganizationId === undefined ? {} : { organizationId: ownerOrganizationId }),
      });
      toast.success(t('profiles.createdToast', { name }));
      router.replace(getProfileOverviewPath(created.id, ownerOrganizationId));
    } catch (error) {
      if (!hasUsableMessage(error)) {
        toast.error(t('profiles.createFailed'));
      }
    }
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profiles.newProfile')} />
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-4 px-6 pt-4 pb-8"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        <FormField
          label={t('profiles.nameLabel')}
          placeholder={t('profiles.namePlaceholder')}
          error={nameError ?? undefined}
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
          multiline
          textAlignVertical="top"
          className="min-h-20 leading-5"
          onChangeText={value => {
            descriptionRef.current = value;
          }}
        />

        {organizationId != null ? (
          <View className="gap-1">
            <Text className="text-sm font-medium text-foreground">{t('profiles.ownerLabel')}</Text>
            <View className="overflow-hidden rounded-lg bg-secondary px-3">
              <ChoiceRow
                label={t('common.personal')}
                selected={owner === 'personal'}
                onPress={() => {
                  setOwner('personal');
                }}
              />
              <ChoiceRow
                label={t('common.organization')}
                selected={owner === 'organization'}
                onPress={() => {
                  setOwner('organization');
                }}
              />
            </View>
          </View>
        ) : null}

        <Button
          loading={create.isPending}
          disabled={create.isPending}
          onPress={() => void submit()}
        >
          <Text>{t('profiles.createAction')}</Text>
        </Button>
      </ScrollView>
    </View>
  );
}
