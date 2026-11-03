import type { FetchedSessionData } from './session-manager';
import type { KiloSessionId, SessionConfig } from './types';

/** The composer settings a session's metadata gives, for live opens and cached pages alike. */
export function sessionConfigFromFetchedSession(
  kiloSessionId: KiloSessionId,
  data: FetchedSessionData
): SessionConfig {
  return {
    sessionId: data.cloudAgentSessionId ?? kiloSessionId,
    repository: data.repository ?? '',
    mode: data.mode ?? '',
    model: data.model ?? '',
    providerID: null,
    variant: data.variant ?? null,
    runtimeAgents: data.runtimeAgents,
  };
}
