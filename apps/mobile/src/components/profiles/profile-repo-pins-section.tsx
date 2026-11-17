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
import { GitBranch, Link2, Plus, Trash2 } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  useRepoBindingMutations,
  useRepoBindings,
  useRepoOptions,
} from '@/lib/hooks/use-repo-bindings';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  ICON_TARGET_BOX_CLASS,
  SECTION_ACTION_BOX_CLASS,
  SECTION_ACTION_HIT_SLOP,
  SECTION_ACTION_ROW_CANCEL_CLASS,
  SECTION_HEADER_ROW_PADDING_CLASS,
} from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

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
        {/* The placeholder reserves the compact box the loaded action renders, not
            a rem-scaled height: NativeWind's 14 pt rem draws `h-7` at 24.5 dp,
            which would let the card grow when the bindings land. */}
        <Skeleton className={cn(SECTION_ACTION_BOX_CLASS, 'w-24 rounded-md bg-muted-soft')} />
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

  return (
    <View className="gap-3 rounded-lg border border-border p-3">
      {/* The row reserves the action's hit slop as padding and cancels the same
          amount from its own height, so the action's whole reach sits inside the
          row that delivers its touches while the card keeps one text line. */}
      <View
        className={cn(
          'flex-row items-center justify-between gap-2',
          SECTION_HEADER_ROW_PADDING_CLASS,
          SECTION_ACTION_ROW_CANCEL_CLASS
        )}
      >
        <View className="flex-row items-center gap-2">
          <GitBranch size={16} color={colors.mutedForeground} />
          <Text className="text-sm font-medium text-foreground">
            {t('profiles.repoBindings.pinnedTitle')}
          </Text>
        </View>
        {canManage ? (
          <Pressable
            className={cn(
              SECTION_ACTION_BOX_CLASS,
              // The outlined secondary chrome the action carried before, at the
              // compact frame: the box holds the height, so no vertical padding,
              // and the label is the body font the card's own rows read in.
              'shrink-0 flex-row items-center justify-center gap-1.5 rounded-md border border-border px-2.5 active:opacity-80 dark:border-neutral-700 dark:bg-secondary',
              'bg-card shadow-sm shadow-[#0000000D]',
              bind.isPending && 'opacity-50'
            )}
            hitSlop={SECTION_ACTION_HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={t('profiles.repoBindings.pinRepo')}
            accessibilityState={{ disabled: bind.isPending }}
            disabled={bind.isPending}
            onPress={() => {
              setPickerOpen(true);
            }}
          >
            <Plus size={14} color={colors.foreground} />
            <Text className="shrink text-sm font-semibold text-foreground">
              {t('profiles.repoBindings.pinRepo')}
            </Text>
          </Pressable>
        ) : null}
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
              <Text
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                className="text-[10px] uppercase tracking-wider text-muted-foreground"
              >
                {repoPlatformBadge(binding.platform)}
              </Text>
              {canManage ? (
                <Pressable
                  className={cn(ICON_TARGET_BOX_CLASS, 'active:opacity-70')}
                  accessibilityRole="button"
                  accessibilityLabel={t('profiles.repoBindings.removeForRepo', {
                    repo: binding.repoFullName,
                  })}
                  disabled={unbind.isPending}
                  onPress={() => {
                    void handleUnbind(
                      binding.repoFullName,
                      binding.platform as RepoBindingPlatform
                    );
                  }}
                >
                  <Trash2 size={16} color={colors.mutedForeground} />
                </Pressable>
              ) : null}
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
