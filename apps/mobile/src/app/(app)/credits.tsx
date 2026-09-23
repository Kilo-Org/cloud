import { CreditNativeIapOwner } from '@/components/credits/credit-native-iap-owner';
import { CreditPurchaseScreen } from '@/components/credits/credit-purchase-screen';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';

export default function CreditsRoute() {
  // The balance can change off-screen (another device, a grant); refresh it when
  // this modal regains foreground.
  useRouteForegroundRefresh([[['user', 'getContextBalance']]]);
  return (
    <CreditNativeIapOwner>
      <CreditPurchaseScreen />
    </CreditNativeIapOwner>
  );
}
