import { type Href, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { ProfileManageSlot } from '@/components/profiles/profile-manage-slot';
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
import { GitBranch, Plus } from '@/components/ui/icons';
import { IconButton } from '@/components/ui/icon-button';
import { RowGroup } from '@/components/ui/row-group';
import { useAgentProfileList } from '@/lib/hooks/use-agent-profiles';
import { useOrganizationProfilePermission } from '@/lib/hooks/use-can-manage-profiles';
import {
  useRepoBindingMutations,
  useRepoBindings,
  useRepoOptions,
} from '@/lib/hooks/use-repo-bindings';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
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
  const colors = useThemeColors();
  const bindingsQuery = useRepoBindings(organizationId);
  const { bind, unbind } = useRepoBindingMutations(organizationId);
  const profileList = useAgentProfileList(organizationId);
  // Personal scope is always manageable; an organization bind, unbind or
  // profile create needs a manage role, and the server rejects them without
  // one. `resolving` is not yet a refusal, so the slot that holds those actions
  // waits for the role instead of claiming the read-only sentence.
  const profilePermission = useOrganizationProfilePermission(organizationId);
  // The server refuses an organization bind and unbind without the manage role
  // (`ensureOrganizationManageAccess`), so the screen withholds those controls
  // instead of offering a write that comes back rejected.
  const canManage = profilePermission === 'allowed';

  const [isAdding, setIsAdding] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<RepoOption | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [profilePickerOpen, setProfilePickerOpen] = useState(false);

  // The Add flow belongs to the permission it opened under, and the screen can
  // learn a new permission while that flow is on screen: the sheets are native
  // sheets over this route, so the route keeps focus and nothing else closes
  // them. The flow therefore lasts only as long as the permission that allows
  // it, and closing it here keeps every control it presents in step with the
  // slot that decides whether Add is offered.
  useEffect(() => {
    if (canManage) {
      return;
    }
    setSelectedRepo(null);
    setSelectedProfileId('');
    setIsAdding(false);
    setRepoPickerOpen(false);
    setProfilePickerOpen(false);
  }, [canManage]);

  const repoOptions = useRepoOptions(organizationId, isAdding);
  const profileChoices =
    organizationId === undefined ? profileList.personalProfiles : profileList.orgProfiles;
  const selectedRepoKey = selectedRepo === null ? null : repositoryOptionKey(selectedRepo);
  const chosenRepo: ChosenRepo =
    selectedRepo === null ? { kind: 'none' } : { kind: 'chosen', repo: selectedRepo };
  const chosenProfile = chosenProfileOf(selectedProfileId, profileChoices);
  const canAdd = chosenRepo.kind === 'chosen' && chosenProfile.kind === 'chosen' && !bind.isPending;
  // The picker opens only from the Add control, which the slot withholds
  // without the manage role, so its empty state names the profile this
  // context lists and never who may create one.
  const pickerEmptyDescription = t(pickerEmptyDescriptionKey(organizationId));
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

  const isEmpty =
    !bindingsQuery.isError && !bindingsQuery.isLoading && bindingsQuery.bindings.length === 0;
  // An empty list with no form open is the whole surface: its own state carries
  // the Add action, and a member's state says why it has none instead of a
  // second sentence under the copy.
  const emptySurface = isEmpty && !isAdding;
  // A read-only viewer is told the rule instead of an action the screen withholds.
  const readOnlyDescription =
    profilePermission === 'read-only' ? t('profiles.organizationRoleRequired') : undefined;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('profiles.repoBindings.title')}
        backFallback={backFallback}
        headerRight={
          canManage ? (
            <IconButton
              accessibilityLabel={t('profiles.repoBindings.add')}
              onPress={() => {
                setIsAdding(true);
              }}
            >
              <Plus size={22} color={colors.foreground} />
            </IconButton>
          ) : undefined
        }
      />
      {emptySurface ? (
        <EmptyState
          icon={GitBranch}
          title={t('profiles.repoBindings.empty')}
          // The empty state must not name an action the screen withholds: a
          // member cannot add a default, so its state names the role instead.
          description={
            canManage ? t('profiles.repoBindings.emptyDescription') : readOnlyDescription
          }
        />
      ) : (
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
          bindingsQuery.bindings.length > 0 ? (
            <RowGroup leadingTile>
              {bindingsQuery.bindings.map(binding => (
                <RepoBindingRow
                  key={`${binding.platform}:${binding.repoFullName}`}
                  repoFullName={binding.repoFullName}
                  platform={binding.platform}
                  profileName={binding.profileName}
                  isRemoving={unbind.isPending}
                  {...(canManage
                    ? {
                        onRemove: () =>
                          void handleUnbind(
                            binding.repoFullName,
                            binding.platform as RepoBindingPlatform
                          ),
                      }
                    : {})}
                />
              ))}
            </RowGroup>
          ) : null}

          {/* The form opens from the header's create control, so the slot holds
              the form or the sentence that names who may add one. */}
          <ProfileManageSlot permission={profilePermission}>
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
            ) : null}
          </ProfileManageSlot>
        </TabScreenScrollView>
      )}

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
          onCreateProfile={canManage ? openProfileCreator : undefined}
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
