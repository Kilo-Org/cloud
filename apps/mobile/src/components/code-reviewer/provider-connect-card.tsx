import * as WebBrowser from 'expo-web-browser';
import { GitBranch, GitMerge } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { getGitHubIntegrationUrl } from '@/lib/agent-github-integration';
import { WEB_BASE_URL } from '@/lib/config';
import { PERSONAL_SCOPE } from '@/lib/hooks/use-code-reviewer';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getGitLabIntegrationUrl } from '@/lib/integration-urls';

const PLATFORM_CONFIG = {
  github: {
    icon: GitBranch,
    label: 'GitHub App',
    buttonLabel: 'Connect GitHub',
    getUrl: getGitHubIntegrationUrl,
    errorMessage: 'Could not open GitHub setup. Please try again.',
  },
  gitlab: {
    icon: GitMerge,
    label: 'GitLab account',
    buttonLabel: 'Connect GitLab',
    getUrl: getGitLabIntegrationUrl,
    errorMessage: 'Could not open GitLab setup. Please try again.',
  },
} as const;

export function ProviderConnectCard({
  scope,
  platform,
  onConnected,
}: Readonly<{
  scope: string;
  platform: 'github' | 'gitlab';
  onConnected: () => Promise<unknown>;
}>) {
  const colors = useThemeColors();
  const [connecting, setConnecting] = useState(false);
  const { icon: Icon, label, buttonLabel, getUrl, errorMessage } = PLATFORM_CONFIG[platform];

  const connect = async () => {
    setConnecting(true);
    try {
      await WebBrowser.openAuthSessionAsync(
        getUrl(WEB_BASE_URL, scope === PERSONAL_SCOPE ? undefined : scope)
      );
      await onConnected();
    } catch {
      toast.error(errorMessage);
    } finally {
      setConnecting(false);
    }
  };

  return (
    <View className="items-center gap-3 rounded-lg bg-secondary p-6">
      <Icon size={28} color={colors.secondaryForeground} />
      <Text className="text-center text-sm text-muted-foreground">
        Connect the Kilo {label} to review pull requests automatically.
      </Text>
      <Button
        className="w-full flex-row gap-2"
        disabled={connecting}
        onPress={() => {
          void connect();
        }}
      >
        {connecting ? <ActivityIndicator size="small" /> : null}
        <Text>{buttonLabel}</Text>
      </Button>
    </View>
  );
}
