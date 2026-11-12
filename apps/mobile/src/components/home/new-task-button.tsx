import { useTranslation } from 'react-i18next';
import { Plus } from '@/components/ui/icons';
import { View } from 'react-native';

import { useNewSessionNavigator } from '@/components/agents/use-new-session-navigator';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type NewTaskButtonProps = {
  organizationId: string | null;
};

export function NewTaskButton({ organizationId }: Readonly<NewTaskButtonProps>) {
  const { openNewSession } = useNewSessionNavigator();
  const { t } = useTranslation();
  const colors = useThemeColors();

  return (
    <View className="mx-4">
      {/* The screen's one primary action, so it keeps the palette's primary
          pair in both schemes: the fill and the ink come from one token pair,
          and the default variant supplies the fill. */}
      <Button
        variant="default"
        size="lg"
        className="w-full"
        onPress={() => {
          openNewSession(organizationId);
        }}
      >
        <Plus size={18} color={colors.primaryForeground} />
        <Text className="shrink text-center font-semibold text-primary-foreground">
          {t('home.newCodingTask')}
        </Text>
      </Button>
    </View>
  );
}
