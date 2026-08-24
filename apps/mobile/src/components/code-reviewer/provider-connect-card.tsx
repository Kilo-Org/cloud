import { GitBranch, GitMerge } from '@/components/ui/icons';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
    label: 'codeReviewer.providerConnect.githubApp',
    buttonLabel: 'codeReviewer.providerConnect.connectGitHub',
    getUrl: getGitHubIntegrationUrl,
    errorMessage: 'codeReviewer.providerConnect.githubError',
  },
  gitlab: {
    icon: GitMerge,
    label: 'codeReviewer.providerConnect.gitlabAccount',
    buttonLabel: 'codeReviewer.providerConnect.connectGitLab',
    getUrl: getGitLabIntegrationUrl,
    errorMessage: 'codeReviewer.providerConnect.gitlabError',
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
  const { t } = useTranslation();
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
      toast.error(t(errorMessage));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <View className="items-center gap-3 rounded-lg bg-secondary p-6">
      <Icon size={28} color={colors.secondaryForeground} />
      <Text className="text-center text-sm text-muted-foreground">
        {t('codeReviewer.providerConnect.description', { label: t(label) })}
      </Text>
      <Button
        className="w-full flex-row gap-2"
        disabled={connecting}
        onPress={() => {
          void connect();
        }}
      >
        {connecting ? <ActivityIndicator size="small" /> : null}
        <Text>{t(buttonLabel)}</Text>
      </Button>
    </View>
  );
}
