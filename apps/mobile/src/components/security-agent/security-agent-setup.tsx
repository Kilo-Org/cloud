import * as WebBrowser from 'expo-web-browser';
import { ShieldCheck } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type SecurityAgentSetupProps = {
  title: string;
  description: string;
  buttonLabel: string;
  url: string;
  /** Awaited in `finally` so permission/config/repository queries refresh after the browser closes. */
  onConnected: () => Promise<unknown>;
};

export function SecurityAgentSetup({
  title,
  description,
  buttonLabel,
  url,
  onConnected,
}: Readonly<SecurityAgentSetupProps>) {
  const colors = useThemeColors();
  const tabBarPadding = useTabBarBottomPadding();
  const [connecting, setConnecting] = useState(false);

  const connect = async () => {
    setConnecting(true);
    try {
      await WebBrowser.openAuthSessionAsync(url);
      await onConnected();
    } catch {
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
