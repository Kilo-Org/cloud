import { type Href, useRouter } from 'expo-router';
import { ChevronDown } from '@/components/ui/icons';
import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type RepoOption as BridgeRepoOption, type RepoPlatform } from '@/lib/picker-bridge';
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
  isLoading: boolean;
  onChange: (repo: string) => void;
  disabled?: boolean;
};

export function RepoSelector({
  value,
  repositories,
  isLoading,
  onChange,
  disabled = false,
}: Readonly<RepoSelectorProps>) {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const effectivelyDisabled = disabled || isLoading || repositories.length === 0;

  // The selection value is `platform:fullName`; display only the fullName.
  const displayValue = value.includes(':') ? value.slice(value.indexOf(':') + 1) : value;
  const label =
    displayValue ||
    (isLoading ? t('agentChat.repoPicker.loading') : t('agentChat.repoPicker.title'));

  function handlePress() {
    if (effectivelyDisabled) {
      return;
    }
    const bridgeRepositories: BridgeRepoOption[] = repositories.map(repo => ({
      platform: repo.platform ?? 'github',
      fullName: repo.fullName,
      isPrivate: repo.isPrivate,
      ...(repo.workspaceUuid !== undefined ? { workspaceUuid: repo.workspaceUuid } : {}),
      ...(repo.repositoryUuid !== undefined ? { repositoryUuid: repo.repositoryUuid } : {}),
    }));
    repoPickerSlot.set(UNFENCED_ROUTE_KEY, {
      repositories: bridgeRepositories,
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
