import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { ProfilePickerSheet } from '@/components/profiles/repo-bindings-profile-sheet';
import { RepoPickerSheet } from '@/components/profiles/repo-picker-sheet';
import {
  type RepoBindingPlatform,
  type RepoOption,
  repoPlatformBadge,
  repositoryOptionKey,
} from '@/components/profiles/repo-bindings-model';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { ChevronDown, GitBranch, Trash2 } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAgentProfileList } from '@/lib/hooks/use-agent-profiles';
import {
  useRepoBindingMutations,
  useRepoBindings,
  useRepoOptions,
} from '@/lib/hooks/use-repo-bindings';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/** The mutation hook toasts `error.message`; the screen supplies a fallback otherwise. */
function hasUsableMessage(error: unknown): boolean {
  return error instanceof Error && error.message.trim().length > 0;
}

/**
 * Content-shaped rows in the same slot and height as a loaded binding row, so
 * the swap from skeleton to bindings does not move the Add control below it.
 */
function RepoBindingsSkeleton() {
  return (
    <View className="gap-2">
      {[0, 1, 2].map(index => (
        <Skeleton key={index} className="h-14 w-full rounded-lg bg-muted-soft" />
      ))}
    </View>
  );
}

/** One binding row: repo full name, provider badge, profile name, remove. */
function RepoBindingRow({
  repoFullName,
  platform,
  profileName,
  isRemoving,
  onRemove,
}: Readonly<{
  repoFullName: string;
  platform: string;
  profileName: string;
  isRemoving: boolean;
  onRemove: () => void;
}>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  return (
    <View className="min-h-14 flex-row items-center gap-2 rounded-lg bg-secondary px-3 py-2">
      <GitBranch size={16} color={colors.mutedForeground} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text variant="mono" className="text-sm" numberOfLines={1}>
          {repoFullName}
        </Text>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {profileName}
        </Text>
      </View>
      <Text className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        {repoPlatformBadge(platform)}
      </Text>
      <Pressable
        className="h-11 w-11 items-center justify-center active:opacity-70"
        accessibilityRole="button"
        accessibilityLabel={t('profiles.repoBindings.remove')}
        disabled={isRemoving}
        onPress={onRemove}
      >
        <Trash2 size={18} color={colors.destructive} />
      </Pressable>
    </View>
  );
}

/** A tappable field row that opens one of the Add form's pickers. */
function PickerField({
  label,
  value,
  accessibilityLabel,
  disabled,
  onPress,
}: Readonly<{
  label: string;
  value: string | null;
  accessibilityLabel: string;
  disabled: boolean;
  onPress: () => void;
}>) {
  const colors = useThemeColors();
  return (
    <Pressable
      className="min-h-11 flex-row items-center justify-between gap-2 rounded-md border border-border bg-secondary px-3 py-2 active:opacity-70"
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
    >
      <Text
        className={value === null ? 'text-sm text-muted-foreground' : 'text-sm text-foreground'}
        numberOfLines={1}
      >
        {value ?? label}
      </Text>
      <ChevronDown size={16} color={colors.mutedForeground} />
    </Pressable>
  );
}

/**
 * The repo bindings screen: every default profile binding for the context, with
 * a per-row remove and an Add default form (repo picker + profile picker). The
 * Add action stays disabled until both a repo and a profile are chosen — the
 * web dialog's behaviour — so no invalid submit is possible. Selection is a tap
 * in a native sheet; there is no drag anywhere.
 */
export function RepoBindingsScreen({ organizationId }: Readonly<{ organizationId?: string }>) {
  const { t } = useTranslation();
  const bindingsQuery = useRepoBindings(organizationId);
  const { bind, unbind } = useRepoBindingMutations(organizationId);
  const profileList = useAgentProfileList(organizationId);

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
      <ScrollView
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
              accessibilityLabel={t('profiles.repoBindings.repo')}
              disabled={bind.isPending}
              onPress={() => {
                setRepoPickerOpen(true);
              }}
            />
            <PickerField
              label={t('profiles.repoBindings.profile')}
              value={selectedProfile?.name ?? null}
              accessibilityLabel={t('profiles.repoBindings.profile')}
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
      </ScrollView>

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
