import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';

export function ChildSessionModelLabel({ modelLabel }: Readonly<{ modelLabel: string }>) {
  const { t } = useTranslation();

  return (
    <Text
      className="text-xs leading-[1rem] text-muted-foreground"
      numberOfLines={1}
      accessibilityLabel={t('agentChat.childSession.modelAccessibility', { modelLabel })}
    >
      {modelLabel}
    </Text>
  );
}
