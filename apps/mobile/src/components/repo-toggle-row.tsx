import { Lock } from 'lucide-react-native';
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
        {repo.private ? <Lock size={12} color={colors.mutedForeground} /> : null}
        <Text className="text-sm" numberOfLines={1}>
          {repo.fullName}
        </Text>
      </View>
    </ChoiceRow>
  );
}
