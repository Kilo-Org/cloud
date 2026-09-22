import { ShieldCheck } from '@/components/ui/icons';
import { useState } from 'react';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { openAuthorizationAndWaitForReturn } from '@/lib/pr-review/connect-gate-platform';

type SecurityAgentSetupProps<T> = {
  title: string;
  description: string;
  buttonLabel: string;
  url: string;
  /** Refreshes permission/config/repository queries after the browser closes. */
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
  const [connecting, setConnecting] = useState(false);
  const { t } = useTranslation();

  const connect = async () => {
    setConnecting(true);
    try {
      await openAuthorizationAndWaitForReturn(url);
      await onConnected();
    } catch {
      toast.error(t('securityAgent.setup.couldNotOpenGithub'));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <EmptyState
      icon={ShieldCheck}
      title={title}
      description={description}
      action={
        <Button
          className="w-full flex-row gap-2"
          disabled={connecting}
          onPress={() => {
            void connect();
          }}
        >
          {connecting ? <ActivityIndicator size="small" color={colors.primaryForeground} /> : null}
          <Text>{buttonLabel}</Text>
        </Button>
      }
    />
  );
}
