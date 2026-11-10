import { Lock } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { ChoiceRow } from '@/components/ui/choice-row';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

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
  const { t } = useTranslation();

  return (
    <ChoiceRow
      multi
      selected={selected}
      disabled={disabled}
      onPress={onPress}
      className={className}
      // The lock is decorative, so privacy reaches the name instead: a
      // screen-reader user must be able to tell a private repository from a
      // public one before picking scope. Public rows keep the plain name.
      accessibleName={
        repo.private ? t('common.privateRepositoryA11y', { name: repo.fullName }) : undefined
      }
    >
      <View className="flex-1 flex-row items-center gap-2 pr-3">
        {repo.private ? (
          <View
            className="shrink-0"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Lock size={12} color={colors.mutedForeground} />
          </View>
        ) : null}
        {/* Middle ellipsis keeps the owner tail and the distinguishing repo
            suffix visible; a tail cut left every long row looking identical
            (explorer finding, 2026-10-18). The min-w-0 box makes the name
            truncate inside the row so it can never run into the trailing
            checkmark, which the private lock icon shifts toward. */}
        <View className="min-w-0 flex-1">
          <Text
            className={cn('text-sm', disabled && 'text-muted-foreground')}
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {repo.fullName}
          </Text>
        </View>
      </View>
    </ChoiceRow>
  );
}
