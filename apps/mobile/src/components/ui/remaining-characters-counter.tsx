import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * The room a bounded field has left, counted in characters. The visible counted
 * phrase is the row's accessible name, so what a screen reader reads and what
 * the row shows cannot drift apart; the caller owns when the row exists, so no
 * visibility threshold lives here. The text is not capped to one line: a
 * counted phrase that outgrows the line grows the row.
 */
export function RemainingCharactersCounter({
  remaining,
  className,
}: Readonly<{ remaining: number; className?: string | undefined }>) {
  const { t } = useTranslation();
  return (
    <View className={cn('flex-row justify-end', className)}>
      <Text className="text-xs font-normal text-muted-foreground">
        {t('agentChat.composer.charactersRemaining', { count: remaining })}
      </Text>
    </View>
  );
}
