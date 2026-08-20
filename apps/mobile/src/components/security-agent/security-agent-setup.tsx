import { ShieldCheck } from '@/components/ui/icons';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { useExternalAuthReturn } from '@/lib/external-auth/use-external-auth-return';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { openAuthorizationAndWaitForReturn } from '@/lib/pr-review/connect-gate-platform';

type SecurityAgentSetupProps<T> = {
  title: string;
  description: string;
  buttonLabel: string;
  url: string;
  /** Awaited in `finally` so permission/config/repository queries refresh after the browser closes. */
  onConnected: () => Promise<T>;
};

export function SecurityAgentSetup<T>({
  title,
  description,
  buttonLabel,
  url,
  onConnected,
}: Readonly<SecurityAgentSetupProps<T>>) {
  const colors = useThemeColors();
  const tabBarPadding = useTabBarBottomPadding();
  const [connecting, setConnecting] = useState(false);

  const handleConnected = useCallback(() => {
    void onConnected();
  }, [onConnected]);
  const { markLaunched, clearLaunch } = useExternalAuthReturn(handleConnected);

  const connect = async () => {
    setConnecting(true);
    try {
      markLaunched();
      const trigger = await openAuthorizationAndWaitForReturn(Platform.OS, url);
      if (trigger === 'sheet-close') {
        // iOS: the auth session resolves on sheet close — refresh right here.
        clearLaunch();
        await onConnected();
      }
      // Android: onConnected runs from the foreground handler once the app
      // returns from the plain browser.
    } catch {
      clearLaunch();
      toast.error('Could not open GitHub. Please try again.');
    } finally {
      setConnecting(false);
    }
  };

  return (
    <View
      className="flex-1 items-center justify-center gap-3 bg-background px-6"
      style={{ paddingBottom: tabBarPadding }}
    >
      <ShieldCheck size={28} color={colors.mutedForeground} />
      <Text className="text-center text-base font-semibold">{title}</Text>
      <Text className="text-center text-sm text-muted-foreground">{description}</Text>
      <Button
        className="mt-3 w-full flex-row gap-2"
        disabled={connecting}
        onPress={() => {
          void connect();
        }}
      >
        {connecting ? <ActivityIndicator size="small" color={colors.primaryForeground} /> : null}
        <Text>{buttonLabel}</Text>
      </Button>
    </View>
  );
}
