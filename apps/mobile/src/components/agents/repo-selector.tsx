import { type Href, useRouter } from 'expo-router';
import { ChevronDown } from '@/components/ui/icons';
import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  type RepoOption as BridgeRepoOption,
  REPO_PLATFORM_LABEL_KEYS,
  type RepoPickerSection,
  type RepoPlatform,
} from '@/lib/picker-bridge';
import { repoPickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';
import { cn } from '@/lib/utils';

type RepoOption = {
  fullName: string;
  isPrivate: boolean;
  /** Provider platform; omitted rows are treated as GitHub until d1 fills it. */
  platform?: RepoPlatform;
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

function isRepoPlatform(platform: string): platform is RepoPlatform {
  return platform === 'github' || platform === 'gitlab' || platform === 'bitbucket';
}

/** Constant order for provider sections (Bitbucket only when its rows exist, i.e. an org is set). */
const PROVIDER_SECTION_ORDER: readonly RepoPlatform[] = ['github', 'gitlab', 'bitbucket'];

function toBridgeRepo(repo: RepoOption): BridgeRepoOption {
  return {
    platform: repo.platform ?? 'github',
    fullName: repo.fullName,
    isPrivate: repo.isPrivate,
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
  const recentKeys = new Set(
    recents.map(repo => `${repo.platform ?? 'github'}/${repo.fullName.toLowerCase()}`)
  );
  const sections: RepoPickerSection[] = [];
  if (recents.length > 0) {
    sections.push({
      key: 'recents',
      titleKey: 'agentChat.newSession.recentlyUsed',
      repos: recents.map(repo => toBridgeRepo(repo)),
    });
  }
  for (const platform of PROVIDER_SECTION_ORDER) {
    const repos = repositories.filter(repo => {
      const repoPlatform = repo.platform ?? 'github';
      return (
        repoPlatform === platform &&
        !recentKeys.has(`${repoPlatform}/${repo.fullName.toLowerCase()}`)
      );
    });
    if (repos.length > 0) {
      sections.push({
        key: platform,
        titleKey: REPO_PLATFORM_LABEL_KEYS[platform],
        repos: repos.map(repo => toBridgeRepo(repo)),
      });
    }
  }
  return sections;
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

  // The selection value is `platform:fullName`; show the platform name next to
  // the fullName so two same-name repos on different providers stay distinct in
  // the closed state. A bare fullName (legacy prefill) falls back to the
  // matching row's platform.
  const colonIndex = value.indexOf(':');
  const rawPlatform = colonIndex !== -1 ? value.slice(0, colonIndex) : '';
  const selectedPlatform: RepoPlatform | undefined =
    colonIndex !== -1 && isRepoPlatform(rawPlatform)
      ? rawPlatform
      : repositories.find(repo => repo.fullName === value)?.platform;
  const displayValue = colonIndex !== -1 ? value.slice(colonIndex + 1) : value;
  const platformName = selectedPlatform ? t(REPO_PLATFORM_LABEL_KEYS[selectedPlatform]) : undefined;
  let label = displayValue;
  if (!label) {
    label = isLoading ? t('agentChat.repoPicker.loading') : t('agentChat.repoPicker.title');
  } else if (platformName) {
    label = `${platformName} · ${displayValue}`;
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
