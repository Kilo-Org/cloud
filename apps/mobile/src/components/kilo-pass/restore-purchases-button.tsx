import * as Haptics from 'expo-haptics';
import { ActivityIndicator, Platform } from 'react-native';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  type StoreKiloPassRestorePurchasesResult,
  useStoreKiloPassPurchase,
} from '@/lib/kilo-pass/use-store-kilo-pass-purchase';

type RestorePurchasesButtonProps = {
  /** Called with the outcome instead of the default toast — for callers that render feedback inline. */
  onResult?: (result: StoreKiloPassRestorePurchasesResult) => void;
};

export function RestorePurchasesButton({ onResult }: Readonly<RestorePurchasesButtonProps> = {}) {
  const colors = useThemeColors();
  const { isPending, isRestoringPurchases, restorePurchases } = useStoreKiloPassPurchase();

  if (Platform.OS !== 'ios') {
    return null;
  }

  const disabled = isPending || isRestoringPurchases;

  const handlePress = () => {
    void Haptics.selectionAsync();
    void (async () => {
      const result = await restorePurchases();
      if (onResult) {
        onResult(result);
        return;
      }
      if (result === 'restored') {
        toast.success('Subscription restored.');
      }
      if (result === 'empty') {
        toast.info('No purchases to restore.');
      }
    })();
  };

  return (
    <Button
      accessibilityLabel="Restore Purchases"
      accessibilityState={{ busy: isRestoringPurchases, disabled }}
      className="self-center px-3"
      disabled={disabled}
      onPress={handlePress}
      variant="link"
    >
      {isRestoringPurchases && <ActivityIndicator size="small" color={colors.primary} />}
      <Text>{isRestoringPurchases ? 'Restoring Purchases' : 'Restore Purchases'}</Text>
    </Button>
  );
}
