import { KiloPassSubscriptionScreen } from '@/components/kilo-pass/kilo-pass-subscription-screen';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';

export default function KiloPassRoute() {
  // Refresh only the presentation this screen renders. The whole `kiloPass`
  // prefix also matches the 5-minute store-product catalog, and invalidating
  // that on a foreground regain re-ran the store chain for data the app already
  // held.
  useRouteForegroundRefresh([[['kiloPass', 'getPurchasePresentation']]]);
  return <KiloPassSubscriptionScreen />;
}
