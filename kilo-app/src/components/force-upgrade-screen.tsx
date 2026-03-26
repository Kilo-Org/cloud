import { Linking, Platform, View } from 'react-native';

import logoImage from '../../assets/images/logo.png';
import { Button } from '@/components/ui/button';
import { Image } from '@/components/ui/image';
import { Text } from '@/components/ui/text';

// Replace the iOS URL with the actual App Store ID once published
const STORE_URL = Platform.select({
  ios: 'https://apps.apple.com/app/idYOUR_APP_ID',
  default: 'https://play.google.com/store/apps/details?id=com.kilocode.kiloapp',
});

export function ForceUpgradeScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-background px-8">
      <Image source={logoImage} className="mb-8 h-24 w-24" contentFit="contain" transition={0} />
      <Text className="mb-3 text-center text-2xl font-bold text-foreground">Update Required</Text>
      <Text className="mb-8 text-center text-base text-muted-foreground">
        A new version of Kilo is available. Please update to continue.
      </Text>
      <Button
        className="w-full"
        size="lg"
        onPress={() => {
          void Linking.openURL(STORE_URL);
        }}
      >
        <Text>Update Now</Text>
      </Button>
    </View>
  );
}
