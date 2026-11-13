import type { StoredSession } from './types';

export function maintenanceChatHref(sessionId: string, organizationId?: string | null): string {
  const base = organizationId ? `/organizations/${organizationId}/cloud` : '/cloud';
  return `${base}/chat?sessionId=${encodeURIComponent(sessionId)}`;
}

export function isMaintenanceChatPinned(
  session: Pick<StoredSession, 'chatKind' | 'isMaintenancePinned'>
): boolean {
  return session.chatKind === 'maintenance' && session.isMaintenancePinned === true;
}

export function getVisibleMaintenanceChatSessions(
  sessions: readonly StoredSession[],
  openSessionIds: readonly string[] = sessions.map(session => session.sessionId)
): StoredSession[] {
  const pinned = sessions.filter(isMaintenanceChatPinned);
  const sessionsById = new Map(sessions.map(session => [session.sessionId, session]));
  const visible = openSessionIds.flatMap(sessionId => {
    const session = sessionsById.get(sessionId);
    return session && !isMaintenanceChatPinned(session) ? [session] : [];
  });
  return [...pinned, ...visible];
}
