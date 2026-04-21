import * as WebBrowser from 'expo-web-browser';
import { Server } from 'lucide-react-native';
import { View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { EmptyState } from '@/components/empty-state';
import { ProfileAvatarButton } from '@/components/profile-avatar-button';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
export default function KiloClawTab() {
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="KiloClaw" showBackButton={false} headerRight={<ProfileAvatarButton />} />
      <Animated.View
        entering={FadeIn.duration(200)}
        className="flex-1 items-center justify-center px-4"
      >
        <EmptyState
          icon={Server}
          title="No KiloClaw instances"
          description="You don't have any KiloClaw instances yet."
          action={
            <Button
              variant="outline"
              onPress={() => {
                void WebBrowser.openBrowserAsync('https://app.kilo.ai/claw');
              }}
            >
              <Text>Create</Text>
            </Button>
          }
        />
      </Animated.View>
    </View>
  );
}
