import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { toast } from 'sonner-native';

import { RepoPickerSheet } from '@/components/profiles/repo-picker-sheet';
import { ProfileRowIdentity, profileRowLabel } from '@/components/profiles/profile-row-identity';
import {
  bindingsForProfile,
  type RepoBindingPlatform,
  type RepoOption,
  repoPlatformBadge,
  repoPlatformLabelKey,
} from '@/components/profiles/repo-bindings-model';
import { QueryError } from '@/components/query-error';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Link2, Trash2 } from '@/components/ui/icons';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Section } from '@/components/ui/section';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  useRepoBindingMutations,
  useRepoBindings,
  useRepoOptions,
} from '@/lib/hooks/use-repo-bindings';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { ICON_TARGET_BOX_CLASS, ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

/** The mutation hook toasts `error.message`; the section supplies a fallback otherwise. */
function hasUsableMessage(error: unknown): boolean {
  return error instanceof Error && error.message.trim().length > 0;
}

/** The section's label, description and first row while the bindings load. */
function RepoPinsSkeleton() {
  return (
    <View className="gap-3">
      <Skeleton className="h-2 w-32 rounded bg-muted-soft" />
      <Skeleton className="h-3 w-56 rounded bg-muted-soft" />
      <RowGroup>
        <RowSkeleton subtitle trailingControl />
      </RowGroup>
    </View>
  );
}

/**
 * The `Pinned to repositories` section on the profile Overview: the repos this
 * profile is bound to, with a `Pin a repo` action and a per-row unbind. Ports
 * the web `RepoPinsSection` (`ProfilesListDialog.tsx:895-1144`) to the phone:
 * tap-to-pick, no drag. The loading skeleton reserves the section's space so
 * the Overview does not jump when the bindings land.
 */
export function ProfileRepoPinsSection({
  profileId,
  organizationId,
  canManage,
}: Readonly<{ profileId: string; organizationId?: string; canManage: boolean }>) {
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

  let body = null;
  if (bindingsQuery.isError) {
    body = (
      <QueryError
        variant="server"
        placement="top"
        title={t('profiles.loadFailed')}
        onRetry={() => void bindingsQuery.refetch()}
        isRetrying={bindingsQuery.isRefetching}
      />
    );
  } else if (pinned.length === 0) {
    body = <Text variant="caption">{t('profiles.repoBindings.pinnedEmpty')}</Text>;
  } else {
    body = (
      <RowGroup>
        {pinned.map(binding => (
          <View
            key={`${binding.repoFullName}-${binding.platform}`}
            className={cn(ROW_TARGET_CLASS, 'flex-row items-center gap-3 px-4 py-3')}
          >
            <Link2 size={14} color={colors.mutedForeground} />
            {/* One identity element, first, as the profile's bindings rows read:
                the repository and its provider, then the control that unbinds it. */}
            <ProfileRowIdentity
              label={profileRowLabel(
                binding.repoFullName,
                t(repoPlatformLabelKey(binding.platform))
              )}
            >
              <Text variant="mono" className="text-xs" numberOfLines={1}>
                {binding.repoFullName}
              </Text>
            </ProfileRowIdentity>
            <Eyebrow>{repoPlatformBadge(binding.platform)}</Eyebrow>
            {canManage ? (
              <Pressable
                className={cn(ICON_TARGET_BOX_CLASS, 'active:opacity-70')}
                accessibilityRole="button"
                accessibilityLabel={t('profiles.repoBindings.removeForRepo', {
                  repo: binding.repoFullName,
                })}
                disabled={unbind.isPending}
                onPress={() => {
                  void handleUnbind(binding.repoFullName, binding.platform as RepoBindingPlatform);
                }}
              >
                <Trash2 size={16} color={colors.mutedForeground} />
              </Pressable>
            ) : null}
          </View>
        ))}
      </RowGroup>
    );
  }

  return (
    <Section
      label={t('profiles.repoBindings.pinnedTitle')}
      actionLabel={t('profiles.repoBindings.pinRepo')}
      actionHidden={!canManage}
      actionDisabled={bind.isPending}
      onActionPress={() => {
        if (!bind.isPending) {
          setPickerOpen(true);
        }
      }}
    >
      <Text variant="caption">{t('profiles.repoBindings.pinnedDescription')}</Text>
      {body}
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
    </Section>
  );
}
