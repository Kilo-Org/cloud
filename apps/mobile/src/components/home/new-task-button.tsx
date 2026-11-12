import { useTranslation } from 'react-i18next';
import { Plus } from '@/components/ui/icons';
import { useColorScheme, View } from 'react-native';

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
  const isDark = useColorScheme() === 'dark';

  return (
    <View className="mx-4">
      {/* The screen's one primary action. Light fills it with the palette's
          olive primary; dark's primary (#ffdd00) is the full brand accent and
          glares as a full-width fill under the near-black page. Dark takes
          `--selection` instead — the same olive hue lifted to stand off the
          page — with its own label tone, so the action keeps the light mode's
          weight in both schemes. */}
      <Button
        variant="default"
        size="lg"
        className="w-full bg-primary dark:bg-selection"
        onPress={() => {
          openNewSession(organizationId);
        }}
      >
        <Plus size={18} color={isDark ? colors.selectionForeground : colors.primaryForeground} />
        <Text className="shrink text-center font-semibold text-primary-foreground dark:text-selection-foreground">
          {t('home.newCodingTask')}
        </Text>
      </Button>
    </View>
  );
}
