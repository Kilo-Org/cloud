import { glanceableStatusKind } from '@kilocode/app-shared/glanceable-agents-snapshot';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';
import { toast } from 'sonner-native';

import { IconButton } from '@/components/ui/icon-button';
import { Bell, BellOff } from '@/components/ui/icons';
import { liveActivitiesAllowedBySystem } from '@/glanceable-ios/system-switch';
import {
  dismissFinishedSessionCard,
  followSession,
  getSessionFollowsRevision,
  isSessionFollowed,
  subscribeSessionFollows,
  unfollowSession,
} from '@/lib/glanceable/session-follow';
import { buildActiveSessionsTrayInput } from '@/lib/active-sessions-live';
import {
  getNotificationPermissionGranted,
  subscribeNotificationPermissionGranted,
} from '@/lib/glanceable/live-activity-switch';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useLiveActivityPreference } from '@/lib/hooks/use-live-activity-preference';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrganization } from '@/lib/organization-context';
import { useTRPC } from '@/lib/trpc';

type SessionFollowButtonProps = { sessionId: string };

/**
 * Follow and Unfollow for one session's card
 * (`.specs/mobile-session-live-activity.md`). One session card per platform: a
 * Lock Screen Live Activity on iOS, an ongoing notification on Android, both
 * through `@/lib/glanceable/session-follow`. Follow shows only for a live
 * session the tray counts as working, waiting, or scheduled, and only while the
 * in-app switch, the notification permission, and the system switch allow the
 * surface. Unfollow shows whenever this device follows the session.
 *
 * Android has no system Live Activity switch, so its allowance is always true;
 * iOS reads the real one.
 */
export function SessionFollowButton({ sessionId }: Readonly<SessionFollowButtonProps>) {
  return Platform.OS === 'ios' || Platform.OS === 'android' ? (
    <SessionFollowControl sessionId={sessionId} />
  ) : null;
}

function SessionFollowControl({ sessionId }: Readonly<SessionFollowButtonProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const trpc = useTRPC();
  const { organizationId } = useOrganization();
  const { userId } = useCurrentUserId();
  const { liveActivityEnabled } = useLiveActivityPreference();
  const permissionGranted = useSyncExternalStore(
    subscribeNotificationPermissionGranted,
    getNotificationPermissionGranted
  );
  useSyncExternalStore(subscribeSessionFollows, getSessionFollowsRevision);
  const followed = isSessionFollowed(sessionId);
  // Read the tray the live-sync owner keeps fresh; this control never fetches it.
  const { data } = useQuery({
    ...trpc.activeSessions.list.queryOptions(buildActiveSessionsTrayInput(organizationId)),
    enabled: false,
  });
  const row = data?.sessions.find(candidate => candidate.id === sessionId);

  // Opening a session dismisses its finished card at once.
  useEffect(() => {
    dismissFinishedSessionCard(sessionId);
  }, [sessionId]);

  if (followed) {
    return (
      <IconButton
        onPress={() => {
          unfollowSession(sessionId);
        }}
        accessibilityLabel={t('agentChat.session.unfollow')}
      >
        <BellOff size={20} color={colors.foreground} />
      </IconButton>
    );
  }
  if (
    row === undefined ||
    userId === undefined ||
    glanceableStatusKind(row.status) === 'idle' ||
    !liveActivityEnabled ||
    !permissionGranted ||
    !(Platform.OS === 'android' || liveActivitiesAllowedBySystem())
  ) {
    return null;
  }
  return (
    <IconButton
      onPress={() => {
        const result = followSession(row, { userId, organizationId });
        if (result === 'refused') {
          toast.error(t('glanceable.followFailed'));
        }
      }}
      accessibilityLabel={t('agentChat.session.follow')}
    >
      <Bell size={20} color={colors.foreground} />
    </IconButton>
  );
}
