import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { toast } from 'sonner-native';

import { RepoPickerSheet } from '@/components/profiles/repo-picker-sheet';
import {
  bindingsForProfile,
  type RepoBindingPlatform,
  type RepoOption,
  repoPlatformBadge,
} from '@/components/profiles/repo-bindings-model';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { GitBranch, Link2, Plus, Trash2 } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  useRepoBindingMutations,
  useRepoBindings,
  useRepoOptions,
} from '@/lib/hooks/use-repo-bindings';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/** The mutation hook toasts `error.message`; the section supplies a fallback otherwise. */
function hasUsableMessage(error: unknown): boolean {
  return error instanceof Error && error.message.trim().length > 0;
}

/** A card-shaped skeleton in the same slot as the loaded pins card. */
function RepoPinsSkeleton() {
  return (
    <View className="gap-3 rounded-lg border border-border p-3">
      <View className="flex-row items-center justify-between gap-2">
        <Skeleton className="h-4 w-40 rounded bg-muted-soft" />
        <Skeleton className="h-9 w-28 rounded-md bg-muted-soft" />
      </View>
      <Skeleton className="h-4 w-full rounded bg-muted-soft" />
      <Skeleton className="h-9 w-full rounded-md bg-muted-soft" />
    </View>
  );
}

/**
 * The `Pinned to repositories` block on the profile Overview: the repos this
 * profile is bound to, with a `Pin a repo` picker and a per-row unbind. Ports
 * the web `RepoPinsSection` (`ProfilesListDialog.tsx:895-1144`) to the phone:
 * tap-to-pick, no drag. The loading skeleton reserves the card's space so the
 * Overview does not jump when the bindings land.
 */
export function ProfileRepoPinsSection({
  profileId,
  organizationId,
}: Readonly<{ profileId: string; organizationId?: string }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const bindingsQuery = useRepoBindings(organizationId);
  const { bind, unbind } = useRepoBindingMutations(organizationId);
  const [pickerOpen, setPickerOpen] = useState(false);
  const repoOptions = useRepoOptions(organizationId, pickerOpen);

  const pinned = bindingsForProfile(bindingsQuery.bindings, profileId);

  const handlePin = async (repo: RepoOption) => {
    setPickerOpen(false);
    try {
      await bind.mutateAsync({
        profileId,
        repoFullName: repo.fullName,
        platform: repo.platform,
      });
    } catch (error) {
      if (!hasUsableMessage(error)) {
        toast.error(t('profiles.repoBindings.pinFailed'));
      }
      return;
    }
    toast.success(t('profiles.repoBindings.pinnedToast', { repo: repo.fullName }));
  };

  const handleUnbind = async (repoFullName: string, platform: RepoBindingPlatform) => {
    try {
      await unbind.mutateAsync({ repoFullName, platform });
    } catch (error) {
      if (!hasUsableMessage(error)) {
        toast.error(t('profiles.repoBindings.unbindFailed'));
      }
      return;
    }
    toast.success(t('profiles.repoBindings.unboundToast'));
  };

  if (bindingsQuery.isLoading && !bindingsQuery.isError) {
    return <RepoPinsSkeleton />;
  }

  return (
    <View className="gap-3 rounded-lg border border-border p-3">
      <View className="flex-row items-center justify-between gap-2">
        <View className="flex-row items-center gap-2">
          <GitBranch size={16} color={colors.mutedForeground} />
          <Text className="text-sm font-medium text-foreground">
            {t('profiles.repoBindings.pinnedTitle')}
          </Text>
        </View>
        <Button
          size="sm"
          variant="outline"
          disabled={bind.isPending}
          accessibilityLabel={t('profiles.repoBindings.pinRepo')}
          onPress={() => {
            setPickerOpen(true);
          }}
        >
          <Plus size={14} color={colors.foreground} />
          <Text>{t('profiles.repoBindings.pinRepo')}</Text>
        </Button>
      </View>

      <Text className="text-xs text-muted-foreground">
        {t('profiles.repoBindings.pinnedDescription')}
      </Text>

      {bindingsQuery.isError ? (
        <QueryError
          variant="server"
          placement="top"
          title={t('profiles.loadFailed')}
          onRetry={() => void bindingsQuery.refetch()}
          isRetrying={bindingsQuery.isRefetching}
        />
      ) : null}

      {!bindingsQuery.isError && pinned.length === 0 ? (
        <Text className="text-xs italic text-muted-foreground">
          {t('profiles.repoBindings.pinnedEmpty')}
        </Text>
      ) : null}

      {!bindingsQuery.isError && pinned.length > 0 ? (
        <View className="gap-1.5">
          {pinned.map(binding => (
            <View
              key={`${binding.repoFullName}-${binding.platform}`}
              className="min-h-11 flex-row items-center gap-2 rounded-md border border-border bg-background px-3 py-2"
            >
              <Link2 size={14} color={colors.mutedForeground} />
              <Text variant="mono" className="min-w-0 flex-1 text-xs" numberOfLines={1}>
                {binding.repoFullName}
              </Text>
              <Text className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {repoPlatformBadge(binding.platform)}
              </Text>
              <Pressable
                className="h-11 w-11 items-center justify-center active:opacity-70"
                accessibilityRole="button"
                accessibilityLabel={t('profiles.repoBindings.remove')}
                disabled={unbind.isPending}
                onPress={() => {
                  void handleUnbind(binding.repoFullName, binding.platform as RepoBindingPlatform);
                }}
              >
                <Trash2 size={16} color={colors.destructive} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      {pickerOpen ? (
        <RepoPickerSheet
          repositories={repoOptions.repositories}
          isLoading={repoOptions.isLoading}
          isError={repoOptions.isError}
          onRetry={() => {
            repoOptions.refetch();
          }}
          selectedKey={null}
          onSelect={repo => {
            void handlePin(repo);
          }}
          onClose={() => {
            setPickerOpen(false);
          }}
        />
      ) : null}
    </View>
  );
}
