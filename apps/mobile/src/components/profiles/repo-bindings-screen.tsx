import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { type ProfileOwnerChoice } from '@/components/profiles/profile-owner-model';
import { ProfilePickerSheet } from '@/components/profiles/repo-bindings-profile-sheet';
import {
  type RepoBindingPlatform,
  type RepoOption,
  repositoryOptionKey,
} from '@/components/profiles/repo-bindings-model';
import {
  PickerField,
  RepoBindingRow,
  RepoBindingsSkeleton,
} from '@/components/profiles/repo-bindings-rows';
import { RepoPickerSheet } from '@/components/profiles/repo-picker-sheet';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { GitBranch } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useAgentProfileList } from '@/lib/hooks/use-agent-profiles';
import { useCanManageOrganizationProfiles } from '@/lib/hooks/use-can-manage-profiles';
import {
  useRepoBindingMutations,
  useRepoBindings,
  useRepoOptions,
} from '@/lib/hooks/use-repo-bindings';
import { getNewProfilePath, type ProfileManagementStack } from '@/lib/profile-agent-navigation';

/** The mutation hook toasts `error.message`; the screen supplies a fallback otherwise. */
function hasUsableMessage(error: unknown): boolean {
  return error instanceof Error && error.message.trim().length > 0;
}

/**
 * The picker's empty-state copy. It names the profile a user could select in
 * this context: a personal one, an organization one, or — without the manage
 * role — who can create an organization profile, since the server rejects the
 * create itself.
 */
const PICKER_EMPTY_DESCRIPTION_KEYS = {
  personal: 'profiles.emptyDescription',
  organization: 'profiles.repoBindings.pickerEmptyDescriptionOrganization',
  organizationReadOnly: 'profiles.repoBindings.pickerEmptyDescriptionOrganizationReadOnly',
} as const;

type PickerEmptyDescriptionKey =
  (typeof PICKER_EMPTY_DESCRIPTION_KEYS)[keyof typeof PICKER_EMPTY_DESCRIPTION_KEYS];

function pickerEmptyDescriptionKey(
  organizationId: string | undefined,
  canManageProfiles: boolean
): PickerEmptyDescriptionKey {
  if (organizationId === undefined) {
    return PICKER_EMPTY_DESCRIPTION_KEYS.personal;
  }
  return canManageProfiles
    ? PICKER_EMPTY_DESCRIPTION_KEYS.organization
    : PICKER_EMPTY_DESCRIPTION_KEYS.organizationReadOnly;
}

/**
 * The repo bindings screen: every default profile binding for the context, with
 * a per-row remove and an Add default form (repo picker + profile picker). The
 * Add action stays disabled until both a repo and a profile are chosen — the
 * web dialog's behaviour — so no invalid submit is possible. Selection is a tap
 * in a native sheet; there is no drag anywhere.
 */
export function RepoBindingsScreen({
  organizationId,
  stack,
}: Readonly<{
  organizationId?: string;
  /** The Stack this screen is mounted in; its create screen opens in it too. */
  stack: ProfileManagementStack;
}>) {
  const router = useRouter();
  const { t } = useTranslation();
  const bindingsQuery = useRepoBindings(organizationId);
  const { bind, unbind } = useRepoBindingMutations(organizationId);
  const profileList = useAgentProfileList(organizationId);
  // Personal scope is always creatable; an organization profile needs a manage
  // role, and the server rejects the create without one.
  const canCreateProfile = useCanManageOrganizationProfiles(organizationId);

  const [isAdding, setIsAdding] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<RepoOption | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [profilePickerOpen, setProfilePickerOpen] = useState(false);

  const repoOptions = useRepoOptions(organizationId, isAdding);
  const profileChoices =
    organizationId === undefined ? profileList.personalProfiles : profileList.orgProfiles;
  const selectedProfile = profileChoices.find(profile => profile.id === selectedProfileId);
  const selectedRepoKey = selectedRepo === null ? null : repositoryOptionKey(selectedRepo);
  const canAdd = selectedRepo !== null && selectedProfileId !== '' && !bind.isPending;
  // The picker lists this context's own profiles, so its empty state names the
  // profile that would appear there.
  const pickerEmptyDescription = t(pickerEmptyDescriptionKey(organizationId, canCreateProfile));
  // The create form starts on the owner whose profiles this context lists.
  const createOwner: ProfileOwnerChoice =
    organizationId === undefined ? 'personal' : 'organization';

  const openProfileCreator = () => {
    setProfilePickerOpen(false);
    router.push(
      getNewProfilePath(stack, {
        owner: createOwner,
        returnTo: 'back',
        // The form must create the profile in the organization whose list this
        // picker shows, which is this screen's scope, not necessarily the
        // account that is active elsewhere in the app.
        ...(organizationId === undefined ? {} : { organizationId }),
      })
    );
  };

  const resetAdd = () => {
    setSelectedRepo(null);
    setSelectedProfileId('');
    setIsAdding(false);
  };

  const handleAdd = async () => {
    if (selectedRepo === null || selectedProfileId === '') {
      return;
    }
    try {
      await bind.mutateAsync({
        profileId: selectedProfileId,
        repoFullName: selectedRepo.fullName,
        platform: selectedRepo.platform,
      });
    } catch (error) {
      if (!hasUsableMessage(error)) {
        toast.error(t('profiles.repoBindings.addFailed'));
      }
      return;
    }
    toast.success(t('profiles.repoBindings.addedToast', { repo: selectedRepo.fullName }));
    resetAdd();
  };

  const handleUnbind = async (repoFullName: string, platform: RepoBindingPlatform) => {
    try {
      await unbind.mutateAsync({ repoFullName, platform });
    } catch (error) {
      if (!hasUsableMessage(error)) {
        toast.error(t('profiles.repoBindings.removeFailed'));
      }
      return;
    }
    toast.success(t('profiles.repoBindings.removedToast', { repo: repoFullName }));
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profiles.repoBindings.title')} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-3 px-6 pt-4 pb-8"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        {bindingsQuery.isError ? (
          <QueryError
            variant="server"
            placement="top"
            title={t('profiles.loadFailed')}
            onRetry={() => void bindingsQuery.refetch()}
            isRetrying={bindingsQuery.isRefetching}
          />
        ) : null}

        {!bindingsQuery.isError && bindingsQuery.isLoading ? <RepoBindingsSkeleton /> : null}

        {!bindingsQuery.isError &&
        !bindingsQuery.isLoading &&
        bindingsQuery.bindings.length === 0 ? (
          <EmptyState
            icon={GitBranch}
            title={t('profiles.repoBindings.empty')}
            description={t('profiles.repoBindings.emptyDescription')}
            placement="top"
          />
        ) : null}

        {!bindingsQuery.isError && !bindingsQuery.isLoading && bindingsQuery.bindings.length > 0 ? (
          <View className="gap-2">
            {bindingsQuery.bindings.map(binding => (
              <RepoBindingRow
                key={`${binding.platform}:${binding.repoFullName}`}
                repoFullName={binding.repoFullName}
                platform={binding.platform}
                profileName={binding.profileName}
                isRemoving={unbind.isPending}
                onRemove={() => {
                  void handleUnbind(binding.repoFullName, binding.platform as RepoBindingPlatform);
                }}
              />
            ))}
          </View>
        ) : null}

        {isAdding ? (
          <View className="gap-3 rounded-lg border border-border p-3">
            <PickerField
              label={t('profiles.repoBindings.repo')}
              value={selectedRepo?.fullName ?? null}
              accessibilityLabel={
                selectedRepo === null
                  ? t('profiles.repoBindings.repo')
                  : t('profiles.repoBindings.repoValue', { name: selectedRepo.fullName })
              }
              disabled={bind.isPending}
              onPress={() => {
                setRepoPickerOpen(true);
              }}
            />
            <PickerField
              label={t('profiles.repoBindings.profile')}
              value={selectedProfile?.name ?? null}
              accessibilityLabel={
                selectedProfile === undefined
                  ? t('profiles.repoBindings.profile')
                  : t('profiles.repoBindings.profileValue', { name: selectedProfile.name })
              }
              disabled={bind.isPending}
              onPress={() => {
                setProfilePickerOpen(true);
              }}
            />
            <View className="flex-row justify-end gap-2">
              <Button variant="ghost" disabled={bind.isPending} onPress={resetAdd}>
                <Text>{t('common.cancel')}</Text>
              </Button>
              <Button
                disabled={!canAdd}
                loading={bind.isPending}
                accessibilityLabel={t('profiles.repoBindings.add')}
                onPress={() => {
                  void handleAdd();
                }}
              >
                <Text>{t('profiles.repoBindings.add')}</Text>
              </Button>
            </View>
          </View>
        ) : (
          <Button
            accessibilityLabel={t('profiles.repoBindings.add')}
            onPress={() => {
              setIsAdding(true);
            }}
          >
            <Text>{t('profiles.repoBindings.add')}</Text>
          </Button>
        )}
      </TabScreenScrollView>

      {repoPickerOpen ? (
        <RepoPickerSheet
          repositories={repoOptions.repositories}
          isLoading={repoOptions.isLoading}
          isError={repoOptions.isError}
          onRetry={() => {
            repoOptions.refetch();
          }}
          selectedKey={selectedRepoKey}
          onSelect={repo => {
            setSelectedRepo(repo);
            setRepoPickerOpen(false);
          }}
          onClose={() => {
            setRepoPickerOpen(false);
          }}
        />
      ) : null}

      {profilePickerOpen ? (
        <ProfilePickerSheet
          profiles={profileChoices}
          isLoading={profileList.isLoading}
          isError={profileList.isError}
          isRefetching={profileList.isRefetching}
          selectedProfileId={selectedProfileId}
          emptyDescription={pickerEmptyDescription}
          onCreateProfile={canCreateProfile ? openProfileCreator : undefined}
          onRetry={() => {
            void profileList.refetch();
          }}
          onSelect={profileId => {
            setSelectedProfileId(profileId);
            setProfilePickerOpen(false);
          }}
          onClose={() => {
            setProfilePickerOpen(false);
          }}
        />
      ) : null}
    </View>
  );
}
