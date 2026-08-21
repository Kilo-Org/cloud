import { DeviceSessionsScreen } from '@/components/device-sessions-screen';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';

export default function DeviceSessionsRoute() {
  useRouteForegroundRefresh([[['user']]]);
  return <DeviceSessionsScreen />;
}
