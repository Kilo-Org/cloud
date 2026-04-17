import { type Href, useRouter } from 'expo-router';
import { ChevronDown } from 'lucide-react-native';
import { Pressable } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { setRepoPickerBridge } from '@/lib/picker-bridge';
import { cn } from '@/lib/utils';

type RepoOption = {
  fullName: string;
  isPrivate: boolean;
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
  const effectivelyDisabled = disabled || isLoading || repositories.length === 0;

  const label = value || (isLoading ? 'Loading...' : 'Select repository');

  function handlePress() {
    if (effectivelyDisabled) {
      return;
    }
    setRepoPickerBridge({
      repositories,
      currentValue: value,
      onSelect: onChange,
    });
    router.push('/(app)/agent-chat/repo-picker' as Href);
  }

  return (
    <Pressable
      onPress={handlePress}
      disabled={effectivelyDisabled}
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
