import { canManageOrganization } from '@kilocode/app-shared/organizations';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import {
  createOrganizationId,
  hasOrganizationContext,
  ownerChoices,
  type ProfileOwnerChoice,
} from '@/components/profiles/profile-owner-model';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';
import {
  type ProfileNameError,
  validateProfileDescription,
  validateProfileName,
} from '@/lib/agent-profile-forms';
import { useAgentProfileMutations } from '@/lib/hooks/use-agent-profiles';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';
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
const NAME_ERROR_KEYS = {
  empty: 'profiles.nameRequired',
  'too-long': 'agentChat.newSession.nameTooLong',
} as const satisfies Record<ProfileNameError, string>;

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
  const { organizationId, role, org, isResolving } = useOrgBoundary();
  // No organization context on the hook: the owner choice below decides which
  // `organizationId` each create carries, so a personal create is never
  // rewritten to the selected organization.
  const { create } = useAgentProfileMutations();
  const nameRef = useRef('');
  const nameValidationStarted = useRef(false);
  const descriptionRef = useRef('');
  const [ownerSelection, setOwnerSelection] = useState<{
    organizationId: string | null;
    owner: ProfileOwnerChoice;
  }>({ organizationId: null, owner: 'personal' });
  const canOwnOrganization =
    !isResolving && hasOrganizationContext(organizationId) && canManageOrganization(role);
  const owner: ProfileOwnerChoice =
    canOwnOrganization && ownerSelection.organizationId === organizationId
      ? ownerSelection.owner
      : 'personal';
  const selectOwner = (next: ProfileOwnerChoice) => {
    setOwnerSelection({ organizationId: organizationId ?? null, owner: next });
  };
  const [nameError, setNameError] = useState<ProfileNameError | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);

  const submit = async () => {
    const name = nameRef.current.trim();
    nameValidationStarted.current = true;
    const nameIssue = validateProfileName(name);
    setNameError(nameIssue);
    if (nameIssue !== null) {
      return;
    }

    const description = descriptionRef.current.trim();
    if (validateProfileDescription(description) !== null) {
      setDescriptionError(t('agentChat.newSession.descriptionTooLong'));
      return;
    }
    setDescriptionError(null);
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
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-4 px-6 pt-4 pb-8"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        <FormField
          label={t('profiles.nameLabel')}
          placeholder={t('profiles.namePlaceholder')}
          error={nameError === null ? undefined : t(NAME_ERROR_KEYS[nameError])}
          required
          returnKeyType="next"
          onChangeText={value => {
            nameRef.current = value;
            if (nameValidationStarted.current) {
              setNameError(validateProfileName(value));
            }
          }}
        />
        <FormField
          label={t('profiles.descriptionLabel')}
          placeholder={t('profiles.descriptionPlaceholder')}
          error={descriptionError ?? undefined}
          multiline
          textAlignVertical="top"
          className="min-h-20 leading-5"
          onChangeText={value => {
            descriptionRef.current = value;
            if (descriptionError !== null && validateProfileDescription(value) === null) {
              setDescriptionError(null);
            }
          }}
        />

        {canOwnOrganization ? (
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
              onChange={selectOwner}
              accessibilityLabel={t(OWNER_LABEL_KEY, { defaultValue: t(OWNER_LABEL_FALLBACK_KEY) })}
            />
            {owner === 'organization' && org ? (
              <Text className="text-sm text-muted-foreground">{org.organizationName}</Text>
            ) : null}
          </View>
        ) : null}

        <Button
          loading={create.isPending}
          disabled={create.isPending}
          onPress={() => void submit()}
        >
          <Text>{t('profiles.createAction')}</Text>
        </Button>
      </TabScreenScrollView>
    </View>
  );
}
