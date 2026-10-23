import { useQueryClient } from '@tanstack/react-query';
import { type Href, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { selectProfileOverviewErrorView } from '@/components/profiles/profile-overview-error';
import {
  defaultDescriptionKey,
  deleteErrorMessage,
  metadataFormKey,
  type OverviewSectionKey,
  overviewSectionRows,
} from '@/components/profiles/profile-overview-model';
import { ProfileMetadataForm } from '@/components/profiles/profile-metadata-form';
import { ProfileOverviewSkeleton } from '@/components/profiles/profile-overview-skeleton';
import { ProfileRepoPinsSection } from '@/components/profiles/profile-repo-pins-section';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { ConfigureRow } from '@/components/ui/configure-row';
import { useConfirmDialog } from '@/components/ui/dialog';
import {
  Bot,
  CornerDownLeft,
  KeyRound,
  type LucideIcon,
  Server,
  Sparkles,
  Star,
  Terminal,
  Trash2,
} from '@/components/ui/icons';
import { PreferenceRow } from '@/components/ui/preference-row';
import { Text } from '@/components/ui/text';
import { useAgentProfile, useAgentProfileMutations } from '@/lib/hooks/use-agent-profiles';
import { useCanManageOrganizationProfiles } from '@/lib/hooks/use-can-manage-profiles';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { useTRPC } from '@/lib/trpc';
import {
  getProfileAgentsPath,
  getProfileCommandsPath,
  getProfileMcpPath,
  getProfileSkillsPath,
  getProfileSlashCommandsPath,
  getProfilesPath,
  getProfileVariablesPath,
  type ProfileManagementStack,
} from '@/lib/profile-agent-navigation';

/** Icon per Overview section, matching the section's purpose. */
const SECTION_ICONS = {
  variables: KeyRound,
  commands: Terminal,
  slashCommands: CornerDownLeft,
  mcp: Server,
  skills: Sparkles,
  agents: Bot,
} satisfies Record<OverviewSectionKey, LucideIcon>;

/** Route builder per Overview section, carrying the profile's context. */
const SECTION_PATHS = {
  variables: getProfileVariablesPath,
  commands: getProfileCommandsPath,
  slashCommands: getProfileSlashCommandsPath,
  mcp: getProfileMcpPath,
  skills: getProfileSkillsPath,
  agents: getProfileAgentsPath,
} satisfies Record<
  OverviewSectionKey,
  (profileId: string, organizationId: string | undefined, stack: ProfileManagementStack) => Href
>;

/**
 * The mutation hook toasts `error.message`; the screen only supplies a
 * fallback when the server sent nothing readable.
 */
function hasUsableMessage(error: unknown): boolean {
  return error instanceof Error && error.message.trim().length > 0;
}


export function ProfileOverviewScreen({
  profileId,
  organizationId,
  stack,
}: Readonly<{
  profileId: string;
  organizationId?: string;
  /** The Stack this screen is mounted in; its section rows stay in it. */
  stack: ProfileManagementStack;
}>) {
  const router = useRouter();
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  const colors = useThemeColors();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  // Reactive: a connectivity commit re-renders the error variant selection.
  const committedConnectivity = useCommittedConnectivityStatus();
  const profileQuery = useAgentProfile(profileId, organizationId);
  const { update, deleteProfile, setAsDefault, clearDefault } =
    useAgentProfileMutations(organizationId);
  const canManage = useCanManageOrganizationProfiles(organizationId);

  const profile = profileQuery.data;
  const isOrgOwned = organizationId !== undefined;

  // A profile the server no longer serves leaves the Profiles list advertising
  // a row that can never open: refresh the lists (not the failed detail read,
  // which would only re-issue the same NOT_FOUND) so the dead row leaves them.
  const errorView = profileQuery.isError
    ? selectProfileOverviewErrorView(profileQuery.error, committedConnectivity)
    : null;
  const staleRow = errorView?.staleRow === true;
  useEffect(() => {
    if (!staleRow) {
      return;
    }
    void queryClient.invalidateQueries(trpc.agentProfiles.list.pathFilter());
    void queryClient.invalidateQueries(trpc.agentProfiles.listCombined.pathFilter());
  }, [staleRow, queryClient, trpc]);

  // A terminal refusal replaces the editor: a cached profile the server says
  // cannot be read must not stay editable (Save and Delete would only fail the
  // same way). A retryable failure keeps the cached profile usable under the
  // banner.
  const showContent = profile !== undefined && (errorView === null || errorView.showRetry);

  const saveMetadata = async ({ name, description }: { name: string; description: string }) => {
    try {
      await update.mutateAsync({ profileId, name, description });
      toast.success(t('common.updated'));
      return true;
    } catch (error) {
      if (!hasUsableMessage(error)) {
        toast.error(t('profiles.saveFailed'));
      }
      return false;
    }
  };

  const runDelete = async (profileName: string) => {
    try {
      await deleteProfile.mutateAsync({ profileId });
      toast.success(t('profiles.deletedToast', { name: profileName }));
      router.back();
    } catch (error) {
      if (deleteErrorMessage(error) === 'blocked') {
        toast.error(t('profiles.deleteBlocked'));
      } else if (!hasUsableMessage(error)) {
        toast.error(t('profiles.deleteFailed'));
      }
    }
  };

  const confirmDelete = (profileName: string) => {
    confirm({
      title: t('profiles.deleteTitle'),
      message: t('profiles.deleteMessage'),
      confirmLabel: t('common.delete'),
      onConfirm: () => {
        void runDelete(profileName);
      },
    });
  };

  const defaultPending = setAsDefault.isPending || clearDefault.isPending;

  return (
    <View className="flex-1 bg-background">
      {/* Back keeps the route it was opened from (the Profiles list, or the
          session whose profile chip opened it); `backFallback` still lands on
          Profiles when the app has no history, as a cold deep link does. The
          profile name is user prose, not a UI label, so it keeps a second line
          for a natural break. */}
      <ScreenHeader
        title={profile?.name ?? t('profiles.title')}
        titleNumberOfLines={2}
        backFallback={getProfilesPath()}
      />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-6 px-6 pt-4"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        {/* A stale read keeps the cached profile usable: the error banner sits
            above the content and only takes over when there is nothing to
            show. A confirmed-offline device is a connectivity failure, not a
            server one; `unknown` connectivity keeps the server variant. A
            profile the server refuses (NOT_FOUND, FORBIDDEN) gets its own
            state, drops the Retry that would re-issue the same refusal, and
            replaces the editor. */}
        {errorView ? (
          <QueryError
            variant={errorView.variant}
            placement="top"
            title={
              errorView.variant === 'not-found' || errorView.variant === 'permission'
                ? undefined
                : t('profiles.loadFailed')
            }
            onRetry={errorView.showRetry ? () => void profileQuery.refetch() : undefined}
            isRetrying={profileQuery.isRefetching}
          />
        ) : null}

        {!profileQuery.isError && profile === undefined ? <ProfileOverviewSkeleton /> : null}

        {showContent ? (
          <>
            <ProfileMetadataForm
              key={metadataFormKey(profile)}
              profile={profile}
              isSaving={update.isPending}
              onSave={saveMetadata}
              disabled={!canManage}
            />

            <PreferenceRow
              icon={Star}
              title={t('profiles.defaultSectionTitle')}
              subtitle={t(defaultDescriptionKey(isOrgOwned))}
              value={profile.isDefault}
              disabled={!canManage || defaultPending}
              busy={defaultPending}
              onValueChange={next => {
                if (next) {
                  setAsDefault.mutate({ profileId });
                } else {
                  clearDefault.mutate({ profileId });
                }
              }}
            />

            <ProfileRepoPinsSection profileId={profileId} organizationId={organizationId} />

            <View className="gap-1">
              <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
                {t('profiles.settingsSectionTitle')}
              </Text>
              <View>
                {overviewSectionRows(profile).map((row, index, rows) => (
                  <ConfigureRow
                    key={row.key}
                    icon={SECTION_ICONS[row.key]}
                    title={t(row.titleKey)}
                    subtitle={String(row.count)}
                    last={index === rows.length - 1}
                    onPress={() => {
                      router.push(SECTION_PATHS[row.key](profileId, organizationId, stack));
                    }}
                  />
                ))}
              </View>
            </View>

            {!canManage ? null : (
              <Button
                variant="destructive"
                loading={deleteProfile.isPending}
                disabled={deleteProfile.isPending}
                onPress={() => {
                  confirmDelete(profile.name);
                }}
              >
                <Trash2 size={16} color={colors.destructiveForeground} />
                <Text>{t('common.delete')}</Text>
              </Button>
            )}
          </>
        ) : null}
      </TabScreenScrollView>

      {dialog}
    </View>
  );
}
