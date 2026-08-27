import { type Href, useRouter } from 'expo-router';
import { ChevronDown } from '@/components/ui/icons';
import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  type RepoOption as BridgeRepoOption,
  getRepoOptionKey,
  REPO_PLATFORM_LABEL_KEYS,
  type RepoPickerSection,
  type RepoPlatform,
  resolveRepoOptionByKey,
} from '@/lib/picker-bridge';
import { repoPickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';
import { groupRepoPickerOptions } from '@/lib/repo-picker-filter';
import { cn } from '@/lib/utils';

type RepoOption = {
  fullName: string;
  isPrivate: boolean;
  /** Provider platform; omitted rows are treated as GitHub until d1 fills it. */
  platform?: RepoPlatform;
  platformIntegrationId?: string;
  platformAccountLogin?: string;
  workspaceUuid?: string;
  repositoryUuid?: string;
};

type RepoSelectorProps = {
  value: string;
  repositories: RepoOption[];
  /** Recently used rows, rendered under a "Recently used" section header in the picker. */
  recents: RepoOption[];
  isLoading: boolean;
  onChange: (repo: string) => void;
  disabled?: boolean;
};

function toBridgeRepo(repo: RepoOption): BridgeRepoOption {
  return {
    platform: repo.platform ?? 'github',
    fullName: repo.fullName,
    isPrivate: repo.isPrivate,
    ...(repo.platformIntegrationId !== undefined
      ? { platformIntegrationId: repo.platformIntegrationId }
      : {}),
    ...(repo.platformAccountLogin !== undefined
      ? { platformAccountLogin: repo.platformAccountLogin }
      : {}),
    ...(repo.workspaceUuid !== undefined ? { workspaceUuid: repo.workspaceUuid } : {}),
    ...(repo.repositoryUuid !== undefined ? { repositoryUuid: repo.repositoryUuid } : {}),
  };
}

/**
 * Assemble the picker's grouped sections: a "Recently used" section over the
 * recents, then one provider section per platform (in PROVIDER_SECTION_ORDER)
 * over the provider's non-recent rows. Each recent row appears once (under
 * recents), and Bitbucket only appears when it has rows.
 */
function buildRepoSections({
  repositories,
  recents,
}: {
  repositories: RepoOption[];
  recents: RepoOption[];
}): RepoPickerSection[] {
  const recentKeys = new Set(recents.map(repo => getRepoOptionKey(toBridgeRepo(repo))));
  const sections: RepoPickerSection[] = [];
  if (recents.length > 0) {
    sections.push({
      key: 'recents',
      titleKey: 'agentChat.newSession.recentlyUsed',
      repos: recents.map(repo => toBridgeRepo(repo)),
    });
  }
  const nonRecentRepositories = repositories.filter(
    repo => !recentKeys.has(getRepoOptionKey(toBridgeRepo(repo)))
  );
  return [
    ...sections,
    ...groupRepoPickerOptions(nonRecentRepositories.map(repo => toBridgeRepo(repo))),
  ];
}

export function RepoSelector({
  value,
  repositories,
  recents,
  isLoading,
  onChange,
  disabled = false,
}: Readonly<RepoSelectorProps>) {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const effectivelyDisabled = disabled || isLoading || repositories.length === 0;

  const selectedRepository = resolveRepoOptionByKey(
    repositories.map(repo => toBridgeRepo(repo)),
    value
  );
  const selectedPlatform = selectedRepository?.platform ?? 'github';
  const platformName = selectedRepository
    ? t(REPO_PLATFORM_LABEL_KEYS[selectedPlatform])
    : undefined;
  let label = selectedRepository?.fullName ?? '';
  if (!label) {
    label = isLoading ? t('agentChat.repoPicker.loading') : t('agentChat.repoPicker.title');
  } else if (platformName) {
    label = [platformName, selectedRepository?.platformAccountLogin, label]
      .filter(Boolean)
      .join(' · ');
  }

  function handlePress() {
    if (effectivelyDisabled) {
      return;
    }
    const bridgeRepositories: BridgeRepoOption[] = repositories.map(repo => toBridgeRepo(repo));
    repoPickerSlot.set(UNFENCED_ROUTE_KEY, {
      repositories: bridgeRepositories,
      sections: buildRepoSections({ repositories, recents }),
      currentValue: value,
      onSelect: onChange,
    });
    router.push('/(app)/agent-chat/repo-picker' as Href);
  }

  return (
    <Pressable
      onPress={handlePress}
      disabled={effectivelyDisabled}
      accessibilityRole="button"
      accessibilityLabel={t('agentChat.repoPicker.accessibility', { label })}
      accessibilityState={{ disabled: effectivelyDisabled }}
      className={cn(
        'flex-row items-center justify-between rounded-lg border border-border bg-secondary px-3 py-3',
        effectivelyDisabled && 'opacity-50'
      )}
    >
      <Text
        className={cn('flex-1 text-base', value ? 'text-foreground' : 'text-muted-foreground')}
        numberOfLines={1}
      >
        {label}
      </Text>
      <ChevronDown size={14} color={colors.mutedForeground} />
    </Pressable>
  );
}
