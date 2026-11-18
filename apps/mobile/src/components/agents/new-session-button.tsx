import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type NewSessionButtonProps = {
  onPress: () => void;
  /** Short presentation for a clear region that cannot hold the full state. */
  compact?: boolean;
};

/**
 * The one "New session" action a state surface offers. Both the live Agents
 * list's empty state and the empty session history start a session here, so
 * the same next step renders as one control: the leading plus, the 48pt action
 * floor and the horizontal padding come from here, never from one caller.
 */
export function NewSessionButton({ onPress, compact = false }: Readonly<NewSessionButtonProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  return (
    <Button
      variant="default"
      size={compact ? 'sm' : 'default'}
      className={cn('max-w-full', STATE_ACTION_CLASS)}
      accessibilityLabel={t('common.newSession')}
      onPress={onPress}
    >
      <Plus size={16} color={colors.primaryForeground} />
      <Text className="shrink text-center">{t('common.newSession')}</Text>
    </Button>
  );
}
