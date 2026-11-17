import { type Href, useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { type ProfileOwnerChoice } from '@/components/profiles/profile-owner-model';
import { RepoBindingsAddForm } from '@/components/profiles/repo-bindings-add-form';
import {
  chosenProfileOf,
  type ChosenRepo,
  pickerEmptyDescriptionKey,
} from '@/components/profiles/repo-bindings-add-model';
import { ProfilePickerSheet } from '@/components/profiles/repo-bindings-profile-sheet';
import {
  type RepoBindingPlatform,
  type RepoOption,
  repositoryOptionKey,
} from '@/components/profiles/repo-bindings-model';
import { RepoBindingRow, RepoBindingsSkeleton } from '@/components/profiles/repo-bindings-rows';
import { RepoPickerSheet } from '@/components/profiles/repo-picker-sheet';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { GitBranch } from '@/components/ui/icons';
import { RowGroup } from '@/components/ui/row-group';
import { Text } from '@/components/ui/text';
import { useAgentProfileList } from '@/lib/hooks/use-agent-profiles';
import { useOrganizationProfilePermission } from '@/lib/hooks/use-can-manage-profiles';
import {
  useRepoBindingMutations,
  useRepoBindings,
  useRepoOptions,
} from '@/lib/hooks/use-repo-bindings';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { getNewProfilePath, type ProfileManagementStack } from '@/lib/profile-agent-navigation';
import { type ProfileExternalOpener } from '@/lib/profile-route-stack';

/** The mutation hook toasts `error.message`; the screen supplies a fallback otherwise. */
function hasUsableMessage(error: unknown): boolean {
  return error instanceof Error && error.message.trim().length > 0;
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
  openedFrom,
  backFallback,
}: Readonly<{
  organizationId?: string;
  /** The Stack this screen is mounted in; its create screen opens in it too. */
  stack: ProfileManagementStack;
  /**
   * The outside screen that opened this one. The create form it opens carries
   * the same marker, so the form returns to it on `back` and is not given a
   * profiles list this screen never had.
   */
  openedFrom?: ProfileExternalOpener;
  /** Where the header's Back lands when the screen opens with no history to pop. */
  backFallback?: Href;
}>) {
  const router = useRouter();
  const { t } = useTranslation();
  const bindingsQuery = useRepoBindings(organizationId);
  const { bind, unbind } = useRepoBindingMutations(organizationId);
  const profileList = useAgentProfileList(organizationId);
  // Personal scope is always creatable; an organization profile needs a manage
  // role, and the server rejects the create without one. `resolving` is not yet
  // a refusal, so the picker's create action waits for the answer instead of
  // telling the user they cannot act.
  const profilePermission = useOrganizationProfilePermission(organizationId);
  const canCreateProfile = profilePermission === 'allowed';

  const [isAdding, setIsAdding] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<RepoOption | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [profilePickerOpen, setProfilePickerOpen] = useState(false);

  const repoOptions = useRepoOptions(organizationId, isAdding);
  const profileChoices =
    organizationId === undefined ? profileList.personalProfiles : profileList.orgProfiles;
  const selectedRepoKey = selectedRepo === null ? null : repositoryOptionKey(selectedRepo);
  const chosenRepo: ChosenRepo =
    selectedRepo === null ? { kind: 'none' } : { kind: 'chosen', repo: selectedRepo };
  const chosenProfile = chosenProfileOf(selectedProfileId, profileChoices);
  const canAdd = chosenRepo.kind === 'chosen' && chosenProfile.kind === 'chosen' && !bind.isPending;
  // The picker lists this context's own profiles, so its empty state names the
  // profile that would appear there.
  const pickerEmptyDescription = t(pickerEmptyDescriptionKey(organizationId, profilePermission));
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
        ...(openedFrom === undefined ? {} : { openedFrom }),
      })
    );
  };

  const resetAdd = () => {
    setSelectedRepo(null);
    setSelectedProfileId('');
    setIsAdding(false);
  };

  const handleAdd = async () => {
    if (chosenRepo.kind !== 'chosen' || chosenProfile.kind !== 'chosen') {
      return;
    }
    const { repo } = chosenRepo;
    const { profile } = chosenProfile;
    try {
      await bind.mutateAsync({
        profileId: profile.id,
        repoFullName: repo.fullName,
        platform: repo.platform,
      });
    } catch (error) {
      if (!hasUsableMessage(error)) {
        toast.error(t('profiles.repoBindings.addFailed'));
      }
      return;
    }
    toast.success(t('profiles.repoBindings.addedToast', { repo: repo.fullName }));
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
      <ScreenHeader title={t('profiles.repoBindings.title')} backFallback={backFallback} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
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
          <RowGroup leadingTile>
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
          </RowGroup>
        ) : null}

        {isAdding ? (
          <RepoBindingsAddForm
            chosenRepo={chosenRepo}
            chosenProfile={chosenProfile}
            isPending={bind.isPending}
            canAdd={canAdd}
            onPickRepo={() => {
              setRepoPickerOpen(true);
            }}
            onPickProfile={() => {
              setProfilePickerOpen(true);
            }}
            onCancel={resetAdd}
            onAdd={() => {
              void handleAdd();
            }}
          />
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
