import { useAtomValue } from 'jotai';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { type AssociatedPrData, type SessionManager } from '@kilocode/cloud-agent-sdk';

import { KvRow } from '@/components/ui/kv-row';
import { openExternalUrl } from '@/lib/external-link';
import { resolveSessionPrTapTarget } from '@/lib/session-pr-navigation';

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
      const target = resolveSessionPrTapTarget({ url: targetPr.url });
      if (target.kind === 'in-app') {
        router.push(target.href);
        return;
      }
      await openExternalUrl(target.url, { label: t('common.pullRequest') });
    })();
  };

  return (
    // The badge is the row's value, so it takes the value slot: the label stays
    // left at the row rhythm and the pill keeps its own press target. The pill
    // itself is ~18pt, so the row hands its full height to it (`items-stretch`
    // plus the badge's `self-stretch justify-center`): the whole row answers the
    // tap instead of the short pill alone, and a `hitSlop` would be clipped by
    // the row's own bounds on Android.
    <KvRow
      label={t('common.pullRequest')}
      className="items-stretch"
      value=""
      valueFace="text"
      testID="session-context-pr-row"
      trailing={
        <SessionPrBadge
          pr={pr}
          loading={false}
          className="self-stretch justify-center"
          onPress={() => {
            openPr(pr);
          }}
        />
      }
    />
  );
}
