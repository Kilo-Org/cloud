import { useAtomValue } from 'jotai';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { type AssociatedPrData, type SessionManager } from '@kilocode/cloud-agent-sdk';

import { Text } from '@/components/ui/text';
import { openExternalUrl } from '@/lib/external-link';
import { resolveSessionPrPressTarget } from '@/lib/session-pr-navigation';

import { SessionPrBadge } from './session-pr-badge';

/**
 * The context sheet's PR pill. Subscribes to the session manager's fetched
 * session data directly so no prop threads from the session page; outside a
 * session manager the caller renders nothing. Rendered for every PR state,
 * never gated on goal or PR status.
 *
 * It lives in its own module so the sheet can lazy-load it: the badge and the
 * router/browser imports cannot load in the mounted sheet test's node
 * environment, and only a session with a manager and an associated PR reaches
 * them.
 */
export function SessionContextPrRow({
  manager,
  sessionId,
  onClose,
}: Readonly<{
  manager: SessionManager;
  sessionId: string;
  onClose: () => void;
}>) {
  const { t } = useTranslation();
  const router = useRouter();
  const fetched = useAtomValue(manager.atoms.fetchedSessionData);
  const pr = fetched?.kiloSessionId === sessionId ? fetched.associatedPr : null;
  if (!pr) {
    return null;
  }

  // A native `Modal` keeps its own window above the app after `router.push`,
  // so the sheet must dismiss before the PR route renders; otherwise the push
  // happens behind the still-present sheet. Order is load-bearing.
  const openPr = (targetPr: AssociatedPrData) => {
    onClose();
    void (async () => {
      const target = await resolveSessionPrPressTarget({ url: targetPr.url });
      if (target.kind === 'in-app') {
        router.push(target.href);
        return;
      }
      await openExternalUrl(target.url, { label: t('common.pullRequest') });
    })();
  };

  return (
    <View className="min-h-[44px] flex-row items-stretch justify-between gap-3">
      <Text className="self-center text-xs uppercase tracking-wide text-muted-foreground">
        {t('common.pullRequest')}
      </Text>
      <SessionPrBadge
        pr={pr}
        loading={false}
        // The pill is this row's only control and its compact box is ~18pt;
        // stretching it to the row's 44pt reserves the full touch target,
        // matching the session page's goal pressable (a `hitSlop` would be
        // clipped by the row's own bounds on Android).
        className="self-stretch justify-center"
        onPress={() => {
          openPr(pr);
        }}
      />
    </View>
  );
}
