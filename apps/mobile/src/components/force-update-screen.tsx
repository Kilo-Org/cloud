import { Download } from '@/components/ui/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { openExternalUrl } from '@/lib/external-link';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

const STORE_URL =
  Platform.OS === 'ios'
    ? 'https://apps.apple.com/app/id6761193135'
    : 'https://play.google.com/store/apps/details?id=com.kilocode.kiloapp';

const VERTICAL_GUTTER = 32;
const HORIZONTAL_GUTTER = 32;

type Insets = { readonly top: number; readonly bottom: number };

function makeContentContainerStyle({ top, bottom }: Insets) {
  return {
    flexGrow: 1,
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
    paddingHorizontal: HORIZONTAL_GUTTER,
    paddingTop: top + VERTICAL_GUTTER,
    paddingBottom: bottom + VERTICAL_GUTTER,
  };
}

export function ForceUpdateScreen() {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { top, bottom } = useSafeAreaInsets();
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
    <ScrollView
      className="flex-1"
      contentContainerStyle={makeContentContainerStyle({ top, bottom })}
      showsVerticalScrollIndicator={false}
    >
      <Download size={48} color={colors.foreground} />
      <Text className="mt-6 text-center text-2xl font-bold">{t('forceUpdate.title')}</Text>
      <Text className="mt-3 text-center text-base text-muted-foreground">
        {t('forceUpdate.description')}
      </Text>
      <Button className="mt-8 w-full" size="lg" onPress={() => void openStore()}>
        <Text>{t('forceUpdate.updateNow')}</Text>
      </Button>

      {storeOpenFailed && (
        <View className="mt-4 w-full gap-3">
          <Text className="text-center text-sm text-destructive">
            {t('forceUpdate.couldNotOpenStore')}
          </Text>
          <Button variant="outline" className="w-full" onPress={() => void openStore()}>
            <Text>{t('common.tryAgain')}</Text>
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onPress={() => {
              void openExternalUrl(STORE_URL, { label: 'app store page' });
            }}
          >
            <Text>{t('common.openInBrowser')}</Text>
          </Button>
        </View>
      )}
    </ScrollView>
  );
}
