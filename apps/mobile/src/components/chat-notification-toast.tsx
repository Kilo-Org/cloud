import { type Href, router } from 'expo-router';
import { Pressable, View } from 'react-native';
import { toast } from 'sonner-native';

import logo from '@/../assets/images/logo.png';
import { Image } from '@/components/ui/image';
import { Text } from '@/components/ui/text';

type ChatNotificationToastProps = {
  id: string | number;
  title: string;
  body: string;
  instanceId: string;
};

export function ChatNotificationToast({ id, title, body, instanceId }: ChatNotificationToastProps) {
  return (
    <Pressable
      className="w-full flex-row items-center gap-3 rounded-2xl bg-secondary px-4 py-3 shadow-lg active:opacity-80"
      onPress={() => {
        toast.dismiss(id);
        router.push(`/(app)/chat/${instanceId}` as Href);
      }}
    >
      <Image
        source={logo}
        className="h-10 w-10 rounded-full"
        accessibilityLabel="KiloClaw"
        transition={0}
      />
      <View className="flex-1">
        <Text className="text-sm font-semibold">{title}</Text>
        <Text className="text-xs text-muted-foreground" numberOfLines={2}>
          {body}
        </Text>
      </View>
    </Pressable>
  );
}
