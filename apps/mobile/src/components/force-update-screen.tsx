import { Download } from '@/components/ui/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, Platform, View } from 'react-native';

import { CenteredState } from '@/components/centered-state';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { openExternalUrl } from '@/lib/external-link';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { i18n } from '@/i18n';

const STORE_URL =
  Platform.OS === 'ios'
    ? 'https://apps.apple.com/app/id6761193135'
    : 'https://play.google.com/store/apps/details?id=com.kilocode.kiloapp';

export function ForceUpdateScreen() {
  const colors = useThemeColors();
  const { t } = useTranslation();
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
    <CenteredState>
      <View className="items-center px-8">
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
                void openExternalUrl(STORE_URL, { label: i18n.t('forceUpdate.appStorePage') });
              }}
            >
              <Text>{t('common.openInBrowser')}</Text>
            </Button>
          </View>
        )}
      </View>
    </CenteredState>
  );
}
