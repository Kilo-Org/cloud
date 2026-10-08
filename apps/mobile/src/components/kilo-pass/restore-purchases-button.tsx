import * as Haptics from 'expo-haptics';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useStoreKiloPassRecovery } from '@/lib/kilo-pass/use-store-kilo-pass-recovery';
import { View } from 'react-native';

export function RestorePurchasesButton() {
  const colors = useThemeColors();
  const { signedIn, errorMessage, isRestoringPurchases, restorePurchases } =
    useStoreKiloPassRecovery();
  const { t } = useTranslation();

  const disabled = !signedIn || isRestoringPurchases;

  const handlePress = () => {
    void Haptics.selectionAsync();
    void (async () => {
      const result = await restorePurchases();
      if (result === null) {
        return;
      }
      if (result === 'restored') {
        toast.success(t('kiloPass.subscriptionRestored'));
      }
      if (result === 'empty') {
        toast.info(t('kiloPass.noPurchasesToRestore'));
      }
    })();
  };

  return (
    <View className="gap-2">
      <Button
        accessibilityLabel={t('kiloPass.restorePurchases')}
        accessibilityState={{ busy: isRestoringPurchases, disabled }}
        className="self-center px-3"
        disabled={disabled}
        onPress={handlePress}
        variant="link"
      >
        {isRestoringPurchases && <ActivityIndicator size="small" color={colors.primary} />}
        <Text>
          {isRestoringPurchases ? t('kiloPass.restoringPurchases') : t('kiloPass.restorePurchases')}
        </Text>
      </Button>
      {errorMessage ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {errorMessage}
        </Text>
      ) : null}
    </View>
  );
}
