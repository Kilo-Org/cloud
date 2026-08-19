import { GitBranch, GitMerge } from '@/components/ui/icons';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { getGitHubIntegrationUrl } from '@/lib/agent-github-integration';
import { WEB_BASE_URL } from '@/lib/config';
import { useExternalAuthReturn } from '@/lib/external-auth/use-external-auth-return';
import { PERSONAL_SCOPE } from '@/lib/hooks/use-code-reviewer';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getGitLabIntegrationUrl } from '@/lib/integration-urls';
import { openAuthorizationAndWaitForReturn } from '@/lib/pr-review/connect-gate-platform';
import { trpcClient } from '@/lib/trpc';

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

export function ProviderConnectCard<T>({
  scope,
  platform,
  onConnected,
}: Readonly<{
  scope: string;
  platform: 'github' | 'gitlab';
  onConnected: () => Promise<T>;
}>) {
  const colors = useThemeColors();
  const [connecting, setConnecting] = useState(false);
  const { icon: Icon, label, buttonLabel, getUrl, errorMessage } = PLATFORM_CONFIG[platform];

  const handleConnected = useCallback(() => {
    void onConnected();
  }, [onConnected]);
  const { markLaunched, clearLaunch } = useExternalAuthReturn(handleConnected);

  const connect = async () => {
    setConnecting(true);
    try {
      const orgId = scope === PERSONAL_SCOPE ? undefined : scope;
      let url = getUrl(WEB_BASE_URL, orgId);
      if (platform === 'github') {
        const result = await trpcClient.githubApps.mintInstallState.mutate({
          organizationId: orgId ?? undefined,
          returnTo: '/cloud/sessions',
        });
        url = getGitHubIntegrationUrl(WEB_BASE_URL, orgId, result.token);
      }
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
