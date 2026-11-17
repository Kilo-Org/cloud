import { GitBranch, GitMerge } from '@/components/ui/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { appShellHandoffUrl } from '@/lib/app-shell-handoff';
import { PERSONAL_SCOPE } from '@/lib/hooks/use-code-reviewer';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  openAuthorizationAndWaitForReturn,
  reportLateLaunchFailure,
} from '@/lib/pr-review/connect-gate-platform';

const PLATFORM_CONFIG = {
  github: {
    icon: GitBranch,
    label: 'codeReviewer.providerConnect.githubApp',
    buttonLabel: 'common.connectGithub',
    errorMessage: 'codeReviewer.providerConnect.githubError',
  },
  gitlab: {
    icon: GitMerge,
    label: 'codeReviewer.providerConnect.gitlabAccount',
    buttonLabel: 'common.connectGitlab',
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
  const { icon: Icon, label, buttonLabel, errorMessage } = PLATFORM_CONFIG[platform];

  const connect = async () => {
    setConnecting(true);
    try {
      const orgId = scope === PERSONAL_SCOPE ? undefined : scope;
      const url = await appShellHandoffUrl(
        platform === 'github'
          ? { page: 'github-app', ...(orgId ? { organizationId: orgId } : {}) }
          : { page: 'integration', platform: 'gitlab', ...(orgId ? { organizationId: orgId } : {}) }
      );
      const wait = await openAuthorizationAndWaitForReturn(url);
      // A launch that fails after the app's own return edge ended the wait never
      // reaches the catch below.
      reportLateLaunchFailure(wait, {
        onFailure: () => {
          toast.error(t(errorMessage));
        },
      });
      await onConnected();
    } catch {
      toast.error(t(errorMessage));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <Card className="items-center">
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
    </Card>
  );
}
