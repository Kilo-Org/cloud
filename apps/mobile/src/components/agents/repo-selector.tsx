import { type Href, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { ChevronDown } from '@/components/ui/icons';
import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  REPO_PLATFORM_LABEL_KEYS,
  type RepoPickerSection,
  type RepoPlatform,
} from '@/lib/picker-bridge';
import { repoPickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';
import { cn } from '@/lib/utils';
import {
  type NewSessionRepository,
  type ResolvedNewSessionRepository as RepoOption,
  repositoryKey,
  repositoryLabel,
} from './new-session-repository-state';

type RepoSelectorProps = {
  value: string;
  repositories: NewSessionRepository[];
  recents: NewSessionRepository[];
  isLoading: boolean;
  onChange: (repo: string) => void;
  disabled?: boolean;
};

const PROVIDER_SECTION_ORDER: readonly RepoPlatform[] = ['github', 'gitlab', 'bitbucket'];

function buildRepoSections(repositories: RepoOption[], recents: RepoOption[]): RepoPickerSection[] {
  const recentKeys = new Set(recents.map(repo => repositoryKey(repo)));
  const sections: RepoPickerSection[] = [];
  if (recents.length > 0) {
    sections.push({
      key: 'recents',
      titleKey: 'agentChat.newSession.recentlyUsed',
      repos: recents,
    });
  }
  for (const platform of PROVIDER_SECTION_ORDER) {
    const repos = repositories.filter(
      repo => repo.platform === platform && !recentKeys.has(repositoryKey(repo))
    );
    if (repos.length > 0) {
      sections.push({ key: platform, titleKey: REPO_PLATFORM_LABEL_KEYS[platform], repos });
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
  // Old form props permit unresolved rows. Never put them in a normalized bridge.
  // Remove after old clients/records disappear and the 30-day ledger window expires.
  const available = repositories.filter((repo): repo is RepoOption =>
    Boolean(repo.reference && repo.key && repo.accountId)
  );
  const latest = useRef({ available, onChange, disabled });
  latest.current = { available, onChange, disabled };
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const effectivelyDisabled = disabled || available.length === 0;
  const selected = available.find(repo => repo.key === value);
  const label = selected
    ? `${t(REPO_PLATFORM_LABEL_KEYS[selected.platform])} · ${repositoryLabel(selected)}`
    : t(isLoading ? 'agentChat.repoPicker.loading' : 'agentChat.repoPicker.title');

  function handlePress() {
    if (effectivelyDisabled) {
      return;
    }
    repoPickerSlot.set(UNFENCED_ROUTE_KEY, {
      repositories: available,
      sections: buildRepoSections(
        available,
        recents.flatMap(repo => available.filter(row => row.key === repo.key))
      ),
      currentValue: value,
      onSelect: key => {
        if (
          mounted.current &&
          !latest.current.disabled &&
          latest.current.available.some(repo => repo.key === key)
        ) {
          latest.current.onChange(key);
        }
      },
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
        'min-h-12 flex-row items-center justify-between rounded-lg border border-border bg-secondary px-3 py-3 active:opacity-70',
        effectivelyDisabled && 'opacity-50'
      )}
    >
      <Text
        className={cn('flex-1 text-base', selected ? 'text-foreground' : 'text-muted-foreground')}
      >
        {label}
      </Text>
      <ChevronDown size={14} color={colors.mutedForeground} />
    </Pressable>
  );
}
