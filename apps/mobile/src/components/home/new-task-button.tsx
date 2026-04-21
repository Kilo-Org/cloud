import { type Href, useRouter } from 'expo-router';
import { Plus } from 'lucide-react-native';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type NewTaskButtonProps = {
  organizationId: string | null;
};

export function NewTaskButton({ organizationId }: Readonly<NewTaskButtonProps>) {
  const router = useRouter();
  const colors = useThemeColors();

  return (
    <View className="mx-4">
      <Button
        variant="outline"
        onPress={() => {
          const path = organizationId
            ? `/(app)/agent-chat/new?organizationId=${organizationId}`
            : '/(app)/agent-chat/new';
          router.push(path as Href);
        }}
      >
        <Plus size={16} color={colors.foreground} />
        <Text>New coding task</Text>
      </Button>
    </View>
  );
}
