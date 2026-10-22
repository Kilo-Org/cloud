import { ShieldCheck } from '@/components/ui/icons';
import { useState } from 'react';
import { View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { CenteredState } from '@/components/centered-state';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { openAuthorizationAndWaitForReturn } from '@/lib/pr-review/connect-gate-platform';

type SecurityAgentSetupProps<T> = {
  title: string;
  description: string;
  buttonLabel: string;
  /**
   * The URL to open. Undefined while the install-state token is still being
   * minted or after a failed mint: pressing the button then mints again and
   * only opens once a URL exists, so a transient mint failure never replaces
   * this screen with an error-only page.
   */
  url?: string;
  /** Resolves the current URL (mints when the screen has none) before opening. */
  resolveUrl: () => Promise<string | undefined>;
  /** Refreshes permission/config/repository queries after the browser closes. */
  onConnected: () => Promise<T>;
};

export function SecurityAgentSetup<T>({
  title,
  description,
  buttonLabel,
  url,
  resolveUrl,
  onConnected,
}: Readonly<SecurityAgentSetupProps<T>>) {
  const colors = useThemeColors();
  const [connecting, setConnecting] = useState(false);
  const { t } = useTranslation();

  const connect = async () => {
    setConnecting(true);
    try {
      // The screen may mount without a minted URL (failed or still-pending
      // mint); resolve one now. Opening without a pre-minted token would fail
      // closed on the web side, so a failed resolution aborts the connect.
      const openUrl = (await resolveUrl()) ?? url;
      if (!openUrl) {
        toast.error(t('securityAgent.scopeEntry.setupFailed'));
        return;
      }
      await openAuthorizationAndWaitForReturn(openUrl);
      await onConnected();
    } catch {
      toast.error(t('securityAgent.setup.couldNotOpenGithub'));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <CenteredState>
      <View className="items-center gap-3 px-6">
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
    </CenteredState>
  );
}
