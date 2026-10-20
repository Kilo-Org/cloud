import { type Href } from 'expo-router';

import { getAgentSessionPath } from '@/components/agents/session-detail-routes';

type BriefingSessionRef = {
  sessionId: string;
  sources: readonly { id: string }[];
};

type BriefingSourceRef = {
  id: string;
  sessionId: string;
  kind: string;
};

/**
 * The report fields a session link needs. Structural rather than the router
 * output type so the link rule can be exercised without the app graph.
 */
type BriefingLinkReport = {
  context: { organizationId: string | null };
  sessions: readonly BriefingSessionRef[];
};

/** Evidence kinds that were recorded by a session and open its transcript. */
function isSessionSourceKind(kind: string): kind is 'activity' | 'cost' | 'blocker' {
  return kind === 'activity' || kind === 'cost' || kind === 'blocker';
}

/**
 * The agent-chat route for a session the briefing names. The report's
 * organization rides on the route, so the opened session runs in the
 * briefing's scope from its first frame rather than waiting on the
 * selected-organization switch that precedes the push.
 */
export function briefingSessionHref(report: BriefingLinkReport, kiloSessionId: string): Href {
  return getAgentSessionPath(kiloSessionId, report.context.organizationId ?? undefined);
}

/**
 * The agent-chat route for a session-backed evidence row, or null when the row
 * is an external link. An activity, cost, or blocker source belongs to the
 * session group it was recorded under, so the row opens that group's root — the
 * same session the Agents section names — and falls back to the source's own
 * session when the report no longer carries the group.
 */
export function briefingSourceHref(
  report: BriefingLinkReport,
  source: BriefingSourceRef
): Href | null {
  if (!isSessionSourceKind(source.kind)) {
    return null;
  }
  const rootId =
    report.sessions.find(session => session.sources.some(entry => entry.id === source.id))
      ?.sessionId ?? source.sessionId;
  return briefingSessionHref(report, rootId);
}
