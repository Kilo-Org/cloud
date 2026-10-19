import { Lock } from '@/components/ui/icons';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { ChoiceRow } from '@/components/ui/choice-row';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * Repository checkbox row (lock icon for private repos + full name + check)
 * shared by code-reviewer's and security-agent's repository pickers.
 */
export function RepoToggleRow({
  repo,
  selected,
  disabled,
  onPress,
  className,
}: Readonly<{
  repo: { id: number | string; fullName: string; private?: boolean };
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
  className?: string;
}>) {
  const colors = useThemeColors();

  return (
    <ChoiceRow
      multi
      selected={selected}
      disabled={disabled}
      onPress={onPress}
      className={className}
    >
      <View className="flex-1 flex-row items-center gap-2 pr-3">
        {repo.private ? <Lock size={12} className="shrink-0" color={colors.mutedForeground} /> : null}
        {/* Middle ellipsis keeps the owner tail and the distinguishing repo
            suffix visible; a tail cut left every long row looking identical
            (explorer finding, 2026-10-18). The min-w-0 box makes the name
            truncate inside the row so it can never run into the trailing
            checkmark, which the private lock icon shifts toward. */}
        <View className="min-w-0 flex-1">
          <Text className="text-sm" numberOfLines={1} ellipsizeMode="middle">
            {repo.fullName}
          </Text>
        </View>
      </View>
    </ChoiceRow>
  );
}
