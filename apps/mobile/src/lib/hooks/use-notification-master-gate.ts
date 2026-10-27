import { useQuery } from '@tanstack/react-query';

import { useAuth } from '@/lib/auth/auth-context';
import { getDevicePushToken, getNotificationPermissionStatus } from '@/lib/notifications';
import { useTRPC } from '@/lib/trpc';

import { deriveGateSettled } from './agent-push-preference';

/**
 * The same cache keys the Notifications settings screen reads, so both surfaces
 * share one permission read and one device-token read.
 */
const permissionQueryKey = ['notificationPermission'] as const;
const deviceTokenQueryKey = ['devicePushToken'] as const;

export type NotificationMasterGate = Readonly<{
  /** No answer yet: do not render an enabled/disabled claim. */
  loading: boolean;
  /** Every input answered, including by failing. */
  settled: boolean;
  /** The OS allows this app to post notifications. */
  permissionGranted: boolean;
  /** OS permission granted and this device's token is registered on the account. */
  pushEnabled: boolean;
}>;

/**
 * Whether pushes can reach this device: the OS permission plus a token the
 * account holds. The settings screen's master switch is the same pair, so a
 * screen that says "push is off" and the switch that turns it back on cannot
 * disagree.
 *
 * A permission read that fails counts as not granted, which is what
 * `deriveGateSettled` short-circuits on: the token queries are irrelevant to a
 * closed gate, and the device-token query is disabled while it is closed.
 */
export function useNotificationMasterGate(): NotificationMasterGate {
  const trpc = useTRPC();
  const { token: authToken } = useAuth();

  const permission = useQuery({
    queryKey: permissionQueryKey,
    queryFn: async () => (await getNotificationPermissionStatus()) === 'granted',
  });
  const permissionGranted = permission.data === true;

  const deviceToken = useQuery({
    queryKey: deviceTokenQueryKey,
    queryFn: getDevicePushToken,
    enabled: permissionGranted,
  });
  const pushTokens = useQuery({
    ...trpc.user.getMyPushTokens.queryOptions(),
    enabled: authToken != null,
  });

  const settled = deriveGateSettled({
    permissionSettled: permission.isFetched || permission.isError,
    permissionGranted,
    pushTokensSettled: pushTokens.isFetched || pushTokens.isError,
    deviceTokenSettled: deviceToken.isFetched || deviceToken.isError,
  });
  const registeredToken = deviceToken.data ?? null;
  const serverRegistered =
    registeredToken !== null &&
    (pushTokens.data ?? []).some(entry => entry.token === registeredToken);

  return {
    loading: !settled,
    settled,
    permissionGranted,
    pushEnabled: permissionGranted && serverRegistered,
  };
}
