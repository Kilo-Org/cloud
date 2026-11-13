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

export function getMaintenanceChatSessions(sessions: readonly StoredSession[]): StoredSession[] {
  return sessions
    .filter(session => session.chatKind === 'maintenance')
    .sort(
      (first, second) =>
        Number(isMaintenanceChatPinned(second)) - Number(isMaintenanceChatPinned(first)) ||
        new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime() ||
        second.sessionId.localeCompare(first.sessionId)
    );
}

export function getVisibleMaintenanceChatSessions(
  sessions: readonly StoredSession[],
  openSessionIds: readonly string[] = sessions.map(session => session.sessionId),
  currentSessionId?: string | null
): StoredSession[] {
  const maintenanceSessions = getMaintenanceChatSessions(sessions);
  const maintenance =
    maintenanceSessions.find(session => session.sessionId === currentSessionId) ??
    maintenanceSessions[0];
  const sessionsById = new Map(sessions.map(session => [session.sessionId, session]));
  const visible = openSessionIds.flatMap(sessionId => {
    const session = sessionsById.get(sessionId);
    return session && session.chatKind !== 'maintenance' ? [session] : [];
  });
  return maintenance ? [maintenance, ...visible] : visible;
}
