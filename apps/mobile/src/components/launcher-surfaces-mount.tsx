import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { resolveIncomingUrl } from '@kilocode/app-shared/universal-links';

import { setPendingDeepLink } from '@/lib/deep-link-launch';
import { type ActiveSession, useLiveAgentSessions } from '@/lib/hooks/use-agent-sessions';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { deriveLauncherTargets, waitedSinceFor } from '@/lib/launcher-surfaces';
import {
  createLauncherSurfacesPublisher,
  type LauncherSurfacesPublisher,
} from '@/lib/launcher-surfaces-publish';
import { getLastOpenedSession, subscribeLastOpenedSession } from '@/lib/last-opened-session';
import {
  clearLauncherSurfaces,
  consumePendingLaunchUrl,
  publishLauncherSurfaces,
} from '@/lib/native-launcher-surfaces';
import { useOrganization } from '@/lib/organization-context';
import {
  isAttentionAcked,
  reconcileSessionAttention,
  shouldShowNeedsInput,
  useSessionAttentionRevision,
} from '@/lib/session-attention';

/**
 * The waiting sessions, in the tab layout's exact filter, paired with how long
 * each has waited. `waitedSinceFor` maps the server's `statusUpdatedAt` raise
 * timestamp to the sort key and reports `POSITIVE_INFINITY` for a row without
 * one, so a timestamp-less row can never outrank a row that has a real wait.
 */
function selectWaitingSessions(sessions: readonly ActiveSession[]) {
  return sessions
    .filter(session =>
      shouldShowNeedsInput({
        status: session.status,
        raiseId: session.status,
        isAcked: isAttentionAcked(session.id, session.status),
      })
    )
    .map(session => ({
      id: session.id,
      waitedSince: waitedSinceFor(session.statusUpdatedAt),
    }));
}

/**
 * The launcher entry points, fed by the same `activeSessions.list` query the
 * Agents tab badge reads, so a shortcut and the badge never disagree — including
 * after an ack. Renders nothing: the surfaces live in the OS, so this mount
 * never changes app layout.
 */
export function LauncherSurfacesMount(): null {
  const { t } = useTranslation();
  // One publisher per mount, not one per JS run: `clearLauncherSurfaces` is the
  // documented sign-out path (`native-launcher-surfaces.ts`), and a memo that
  // outlived the mount would suppress the identical next derivation, leaving
  // the shortcuts gone until something else changed. A per-mount memo still
  // collapses the frequent refetches of one signed-in session into a single OS
  // write, and the mount after the next sign-in always writes the list back.
  const publisherRef = useRef<LauncherSurfacesPublisher | null>(null);
  publisherRef.current ??= createLauncherSurfacesPublisher(
    publishLauncherSurfaces,
    clearLauncherSurfaces
  );
  const publisher = publisherRef.current;
  const { organizationId, isLoaded: orgLoaded } = useOrganization();
  const { userId } = useCurrentUserId();
  const { activeSessions, isLoading, isError, hasAcceptedSuccess } = useLiveAgentSessions({
    organizationId,
    enabled: orgLoaded,
  });
  const attentionRevision = useSessionAttentionRevision();

  // The same reconciliation the Agents tab runs, so an ack or expiry lands in
  // the shortcut's wait list on the same revision the badge uses.
  useEffect(() => {
    if (!orgLoaded) {
      return;
    }
    for (const session of activeSessions) {
      reconcileSessionAttention(session.id, session.status, null);
    }
  }, [activeSessions, orgLoaded, attentionRevision]);

  const waiting = selectWaitingSessions(activeSessions);

  const lastOpenedSessionId = useSyncExternalStore(subscribeLastOpenedSession, () =>
    getLastOpenedSession(userId ?? null)
  );

  // Derived in render, like the Agents tab badge: the filter reads the
  // module-level ack store, and `attentionRevision` above is what re-runs this
  // render. The publisher is what keeps the OS write count down, so a repeated
  // derivation costs one string compare.
  const targets = deriveLauncherTargets({ waiting, lastOpenedSessionId });

  // Publish on the happy path only. `hasAcceptedSuccess` keeps an unconfirmed
  // read — an empty list before the first success — from dropping the Needs
  // input shortcut the last run left; an error afterwards leaves the last
  // published payload in place, so the shortcut keeps opening what the badge
  // last showed instead of blanking. The publisher drops repeats.
  useEffect(() => {
    if (!orgLoaded || isLoading || isError || !hasAcceptedSuccess) {
      return;
    }
    publisher.apply(targets, t);
  }, [orgLoaded, isLoading, isError, hasAcceptedSuccess, targets, t, publisher]);

  // The iOS cold-start Quick Action enters through the same slot a notification
  // tap uses. `consumePendingLaunchUrl` clears the native slot as it reads, so a
  // later unrelated mount cannot replay it.
  useEffect(() => {
    const url = consumePendingLaunchUrl();
    if (url === null) {
      return;
    }
    const href = resolveIncomingUrl(url);
    if (href !== null) {
      setPendingDeepLink(href, 'universal-link');
    }
  }, []);

  return null;
}
