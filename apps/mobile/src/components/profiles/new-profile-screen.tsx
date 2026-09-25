import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { toast } from 'sonner-native';

import {
  createOrganizationId,
  hasOrganizationContext,
  ownerChoices,
  type ProfileOwnerChoice,
} from '@/components/profiles/profile-owner-model';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';
import { validateProfileName } from '@/lib/agent-profile-forms';
import { useAgentProfileMutations } from '@/lib/hooks/use-agent-profiles';
import { useOrganization } from '@/lib/organization-context';
import { getProfileOverviewPath } from '@/lib/profile-agent-navigation';

/**
 * Copy keys for the owner control, named here so the catalog entries land with
 * the translation slice. The reviewed English fallbacks keep the control
 * readable until then, and naming the keys in constants (rather than inline in
 * `t()`) is how the catalog check sees them as living keys.
 */
const OWNER_LABEL_KEY = 'profiles.owner.owner';
const OWNER_LABEL_FALLBACK_KEY = 'profiles.ownerLabel';
const OWNER_CHOICE_LABEL_KEYS = {
  personal: 'profiles.owner.personal',
  organization: 'profiles.owner.organization',
} as const satisfies Record<ProfileOwnerChoice, string>;
const OWNER_CHOICE_FALLBACK_KEYS = {
  personal: 'common.personal',
  organization: 'common.organization',
} as const satisfies Record<ProfileOwnerChoice, string>;

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
    const ownerOrganizationId = createOrganizationId(organizationId, owner);
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

        {hasOrganizationContext(organizationId) ? (
          <View className="gap-1">
            <Text className="text-sm font-medium text-foreground">
              {t(OWNER_LABEL_KEY, { defaultValue: t(OWNER_LABEL_FALLBACK_KEY) })}
            </Text>
            <SegmentedControl
              // The create carries the organization only when Organization is
              // chosen; the options come from the active context.
              options={ownerChoices(organizationId).map(choice => ({
                value: choice,
                label: t(OWNER_CHOICE_LABEL_KEYS[choice], {
                  defaultValue: t(OWNER_CHOICE_FALLBACK_KEYS[choice]),
                }),
              }))}
              value={owner}
              onChange={setOwner}
              accessibilityLabel={t(OWNER_LABEL_KEY, { defaultValue: t(OWNER_LABEL_FALLBACK_KEY) })}
            />
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
