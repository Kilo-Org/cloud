type SharingHistory = { source?: { version: 'v1' | 'v2' } };

export function getSessionSharingDisabledReason({
  kiloSessionId,
  cloudAgentSessionId,
  history,
  isError,
}: {
  kiloSessionId?: string;
  cloudAgentSessionId?: string | null;
  history?: SharingHistory | null;
  isError: boolean;
}): string | undefined {
  if (!kiloSessionId) return 'Session ID not available yet.';
  if (!cloudAgentSessionId?.startsWith('workspace_')) return undefined;
  if (history?.source?.version === 'v2') return 'Sharing is not available for Kilo v2 sessions.';
  // A null page means the Session DO has no registration: a legacy v1 session.
  if (history === null) return undefined;
  if (isError)
    return 'Session sharing availability could not be checked. Reopen this dialog to retry.';
  if (history === undefined) return 'Checking session sharing availability…';
  return undefined;
}
