import { KiloPassSubscriptionScreen } from '@/components/kilo-pass/kilo-pass-subscription-screen';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';

export default function KiloPassRoute() {
  useRouteForegroundRefresh([[['kiloPass']]]);
  return <KiloPassSubscriptionScreen />;
}
