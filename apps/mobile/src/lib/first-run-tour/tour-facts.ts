/**
 * Pure outcome classification for the first-run tour screens.
 *
 * The tour ends by pointing at real evidence, so the screens render facts
 * derived from already-fetched lists: a cloud-agent session in the history,
 * a connected `kilo remote` instance, and a live CLI session on one of the
 * instances. This module only classifies; fetching stays with the caller.
 */

export type TourFactsInput = {
  /**
   * `cliSessionsV2.list` history rows. A non-null `cloud_agent_session_id`
   * marks a session owned by a cloud-agent run (the cloud agent registers a
   * `cli_sessions_v2` ownership row with that column set).
   */
  historyRows: readonly { cloud_agent_session_id: string | null }[];
  /**
   * `activeSessions.list` rows. The mobile input omits
   * `includeCloudAgentSessions` (the server defaults it to false), so live
   * rows are CLI-instance sessions; the `cloud-agent` connection id is still
   * excluded defensively.
   */
  liveSessions: readonly { connectionId: string }[];
  /** Connected `kilo remote` instances. */
  instances: readonly { connectionId: string; name: string }[];
};

export type TourFacts = {
  hasCloudSession: boolean;
  connectedInstance: { connectionId: string; name: string } | null;
  hasCliSession: boolean;
};

/** Classify the tour's outcome facts from the three fetched lists. */
export function classifyTourFacts(input: TourFactsInput): TourFacts {
  const hasCloudSession = input.historyRows.some(row => row.cloud_agent_session_id !== null);
  const connectedInstance = input.instances[0] ?? null;
  const instanceConnectionIds = new Set(input.instances.map(instance => instance.connectionId));
  const hasCliSession = input.liveSessions.some(
    session =>
      session.connectionId !== 'cloud-agent' && instanceConnectionIds.has(session.connectionId)
  );
  return { hasCloudSession, connectedInstance, hasCliSession };
}
