import { ShieldCheck } from '@/components/ui/icons';
import { useState } from 'react';
import { View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useTranslation } from 'react-i18next';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { CenteredState } from '@/components/centered-state';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  openAuthorizationAndWaitForReturn,
  reportLateLaunchFailure,
} from '@/lib/pr-review/connect-gate-platform';

type SecurityAgentSetupProps<T> = {
  title: string;
  description: string;
  buttonLabel: string;
  /**
   * Why the reader cannot start this connection themselves, once the server has
   * refused it for their organization role. When set, the action is withheld:
   * the body shows this sentence in the button's own box and never resolves a
   * URL, so the screen cannot offer a press whose destination refuses the
   * reader. A caller the server admits never sets it, so no device-side role
   * read can deny a press.
   */
  readOnlyNotice?: string;
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
  readOnlyNotice,
  url,
  resolveUrl,
  onConnected,
}: Readonly<SecurityAgentSetupProps<T>>) {
  const colors = useThemeColors();
  const [connecting, setConnecting] = useState(false);
  /**
   * Why the last press could not continue. Rendered in this body and kept
   * until a press reaches a new outcome: an app-root toast is not a visible
   * outcome here — a sheet-hosted or backgrounded setup screen leaves the
   * reader staring at an unchanged button. The body is centred on its content
   * height, so dropping the line for the length of an attempt would slide the
   * button under the finger and back; it stays until there is something truer
   * to show.
   */
  const [failure, setFailure] = useState<string | null>(null);
  const { t } = useTranslation();

  const connect = async () => {
    setConnecting(true);
    try {
      // The screen may mount without a minted URL (failed or still-pending
      // mint); resolve one now. Opening without a pre-minted token would fail
      // closed on the web side, so a failed resolution aborts the connect.
      const openUrl = (await resolveUrl()) ?? url;
      if (!openUrl) {
        setFailure(t('securityAgent.scopeEntry.setupFailed'));
        return;
      }
      const wait = await openAuthorizationAndWaitForReturn(openUrl);
      // The page opened, so the previous failure no longer describes this
      // screen; the session itself decides what comes next.
      setFailure(null);
      // A launch that fails after the app's own return edge ended the wait never
      // reaches the catch below.
      reportLateLaunchFailure(wait, {
        onFailure: () => {
          setFailure(t('securityAgent.setup.couldNotOpenGithub'));
        },
      });
      await onConnected();
    } catch {
      setFailure(t('securityAgent.setup.couldNotOpenGithub'));
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
        {readOnlyNotice ? (
          // The notice takes the action's place rather than sitting beside it:
          // this reader has no press to make, and the sentence is the only
          // thing left to say. It keeps the button's own box — `mt-3`, the
          // full-width `min-h-[44px]` at the same padding (`Button`'s default
          // size) — so a role that resolves after mount changes what the block
          // says without re-centring it under the reader's eyes.
          <View className="mt-3 w-full min-h-[44px] items-center justify-center px-4 py-2">
            <Text className="text-center text-xs text-muted-foreground">{readOnlyNotice}</Text>
          </View>
        ) : (
          <Button
            className="mt-3 w-full flex-row gap-2"
            disabled={connecting}
            onPress={() => {
              void connect();
            }}
          >
            {connecting ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : null}
            <Text>{buttonLabel}</Text>
          </Button>
        )}
        {/* A notice leaves nothing to retry, so the press that produced this
            line is no longer the screen's state: drop it rather than leave an
            error beneath an action-less body. */}
        <AccessibleStatus
          message={readOnlyNotice ? null : failure}
          className="text-center text-sm"
        />
      </View>
    </CenteredState>
  );
}
