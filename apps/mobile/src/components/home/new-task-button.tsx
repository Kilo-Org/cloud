import { type Href, useRouter } from 'expo-router';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from '@/components/ui/icons';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type NewTaskButtonProps = {
  organizationId: string | null;
};

// Memoized so a live-session update does not re-render the action section on
// Home while `organizationId` stays stable.
export const NewTaskButton = memo(function NewTaskButton({
  organizationId,
}: Readonly<NewTaskButtonProps>) {
  const router = useRouter();
  const { t } = useTranslation();
  const colors = useThemeColors();

  return (
    <View className="mx-4">
      <Button
        variant="default"
        size="lg"
        className="w-full"
        onPress={() => {
          const path = organizationId
            ? `/(app)/agent-chat/new?organizationId=${organizationId}`
            : '/(app)/agent-chat/new';
          router.push(path as Href);
        }}
      >
        <Plus size={18} color={colors.primaryForeground} />
        <Text className="shrink text-center font-semibold">{t('home.newCodingTask')}</Text>
      </Button>
    </View>
  );
});
