import { Download } from 'lucide-react-native';
import { Linking, Platform, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

const STORE_URL =
  Platform.OS === 'ios'
    ? 'https://apps.apple.com/app/id6761193135'
    : 'https://play.google.com/store/apps/details?id=com.kilocode.kiloapp';

export default function ForceUpdateScreen() {
  const colors = useThemeColors();

  return (
    <View className="flex-1 items-center justify-center px-8">
      <Download size={48} color={colors.foreground} />
      <Text className="mt-6 text-center text-2xl font-bold">Update Required</Text>
      <Text className="mt-3 text-center text-base text-muted-foreground">
        A new version of Kilo is available. Please update to continue.
      </Text>
      <Button className="mt-8 w-full" size="lg" onPress={() => void Linking.openURL(STORE_URL)}>
        <Text>Update Now</Text>
      </Button>
    </View>
  );
}
