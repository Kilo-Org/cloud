import * as WebBrowser from 'expo-web-browser';
import { GitBranch } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { getGitHubIntegrationUrl } from '@/lib/agent-github-integration';
import { WEB_BASE_URL } from '@/lib/config';
import { PERSONAL_SCOPE } from '@/lib/hooks/use-code-reviewer';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export function GitHubConnectCard({
  scope,
  onConnected,
}: Readonly<{ scope: string; onConnected: () => Promise<unknown> }>) {
  const colors = useThemeColors();
  const [connecting, setConnecting] = useState(false);

  const connect = async () => {
    setConnecting(true);
    try {
      await WebBrowser.openAuthSessionAsync(
        getGitHubIntegrationUrl(WEB_BASE_URL, scope === PERSONAL_SCOPE ? undefined : scope)
      );
      await onConnected();
    } catch {
      toast.error('Could not open GitHub setup. Please try again.');
    } finally {
      setConnecting(false);
    }
  };

  return (
    <View className="items-center gap-3 rounded-lg bg-secondary p-6">
      <GitBranch size={28} color={colors.secondaryForeground} />
      <Text className="text-center text-sm text-muted-foreground">
        Connect the Kilo GitHub App to review pull requests automatically.
      </Text>
      <Button
        className="w-full flex-row gap-2"
        disabled={connecting}
        onPress={() => {
          void connect();
        }}
      >
        {connecting ? <ActivityIndicator size="small" /> : null}
        <Text>Connect GitHub</Text>
      </Button>
    </View>
  );
}
