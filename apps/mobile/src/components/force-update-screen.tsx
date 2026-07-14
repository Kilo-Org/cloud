import { Download } from 'lucide-react-native';
import { useState } from 'react';
import { Linking, Platform, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { openExternalUrl } from '@/lib/external-link';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

const STORE_URL =
  Platform.OS === 'ios'
    ? 'https://apps.apple.com/app/id6761193135'
    : 'https://play.google.com/store/apps/details?id=com.kilocode.kiloapp';

export function ForceUpdateScreen() {
  const colors = useThemeColors();
  const [storeOpenFailed, setStoreOpenFailed] = useState(false);

  const openStore = async () => {
    try {
      await Linking.openURL(STORE_URL);
      setStoreOpenFailed(false);
    } catch {
      setStoreOpenFailed(true);
    }
  };

  return (
    <View className="flex-1 items-center justify-center px-8">
      <Download size={48} color={colors.foreground} />
      <Text className="mt-6 text-center text-2xl font-bold">Update required</Text>
      <Text className="mt-3 text-center text-base text-muted-foreground">
        A new version of Kilo is available. Please update to continue.
      </Text>
      <Button className="mt-8 w-full" size="lg" onPress={() => void openStore()}>
        <Text>Update now</Text>
      </Button>

      {storeOpenFailed && (
        <View className="mt-4 w-full gap-3">
          <Text className="text-center text-sm text-destructive">
            Could not open the app store.
          </Text>
          <Button variant="outline" className="w-full" onPress={() => void openStore()}>
            <Text>Try again</Text>
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onPress={() => {
              void openExternalUrl(STORE_URL, { label: 'app store page' });
            }}
          >
            <Text>Open in browser</Text>
          </Button>
        </View>
      )}
    </View>
  );
}
