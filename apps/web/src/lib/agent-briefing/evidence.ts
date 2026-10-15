import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  isNotNull,
  lt,
  lte,
  notLike,
  or,
  sql,
} from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  agent_briefing_events,
  agent_briefing_preferences,
  cli_sessions_v2,
  microdollar_usage,
  microdollar_usage_metadata,
} from '@kilocode/db/schema';
import { redactBriefingExcerpt, type BriefingSource } from '@kilocode/app-shared/agent-briefing';

type Session = Pick<
  typeof cli_sessions_v2.$inferSelect,
  'session_id' | 'parent_session_id' | 'title'
>;
type Event = typeof agent_briefing_events.$inferSelect;
type Usage = { id: string; sessionId: string; cost: number; occurredAt: string };
export type BriefingEvidenceCoverage = {
  activity: 'complete' | 'partial';
  spend: 'complete' | 'partial' | 'unavailable';
  blockers: 'complete' | 'partial';
  pullRequests: 'complete' | 'partial';
};

/**
 * Coverage is complete only where the evidence proves it. `collectionStartedAt`
 * is when this user's briefing collection is known to have been live (their
 * preferences row is created by the feature that ships with the collectors);
 * null or later than the night start means earlier activity may be missing.
 * `legacyStatusInWindow` flags a session status written during the night by a
 * producer that sent no transition identity.
 */
export type BriefingCoverageContext = {
  collectionStartedAt?: string | null;
  legacyStatusInWindow?: boolean;
};

const transitionIdOf = (event: Event) =>
  typeof event.payload?.transitionId === 'string' ? event.payload.transitionId : '';
const compareEvents = (a: Event, b: Event) =>
  Date.parse(a.occurred_at) - Date.parse(b.occurred_at) ||
  transitionIdOf(a).localeCompare(transitionIdOf(b)) ||
  a.id.localeCompare(b.id);
const isBlockedStatus = (event: Event) =>
  event.status === 'question' || event.status === 'permission';

export function aggregateBriefingEvidence(
  rows: Session[],
  events: Event[],
  usage: Usage[],
  nightStartAt: string,
  cutoffAt: string,
  coverageContext: BriefingCoverageContext = {}
) {
  const start = Date.parse(nightStartAt);
  const cutoff = Date.parse(cutoffAt);
  const collectionStartedAt = coverageContext.collectionStartedAt ?? null;
  const collectionCovered =
    collectionStartedAt !== null && Date.parse(collectionStartedAt) <= start;
  let untimestampedStatus = coverageContext.legacyStatusInWindow === true;
  const activityRoots = new Set<string>();
  const spendRoots = new Set<string>();
  const byId = new Map(rows.map(row => [row.session_id, row]));
  const rootById = new Map<string, Session>();
  for (const row of rows) {
    let root = row;
    const seen = new Set([row.session_id]);
    while (root.parent_session_id) {
      const parent = byId.get(root.parent_session_id);
      if (!parent || seen.has(parent.session_id)) break;
      root = parent;
      seen.add(root.session_id);
    }
    rootById.set(row.session_id, root);
  }
  const groups = new Map<
    string,
    {
      sessionId: string;
      title: string;
      url: string;
      status: string | null;
      spendMicrodollars: number;
      sources: BriefingSource[];
    }
  >();
  const groupFor = (sessionId: string) => {
    const root = rootById.get(sessionId);
    if (!root) return undefined;
    let group = groups.get(root.session_id);
    if (!group) {
      group = {
        sessionId: root.session_id,
        title: root.title ?? 'Coding session',
        url: `/cloud/sessions/${encodeURIComponent(root.session_id)}`,
        status: null,
        spendMicrodollars: 0,
        sources: [],
      };
      groups.set(root.session_id, group);
    }
    return group;
  };
  const statuses = new Map<string, { latest: Event; blockedSince: Event | null }>();
  const uniqueEvents = new Map(events.map(event => [event.id, event]));
  const ordered = [...uniqueEvents.values()].sort(compareEvents);
  const pullRequests = new Set<string>();
  const activeRoots = new Set<string>();
  for (const event of ordered) {
    const at = Date.parse(event.occurred_at);
    if (!Number.isFinite(at) || at > cutoff || !rootById.has(event.session_id)) continue;
    if (
      event.kind === 'status' &&
      at >= start &&
      event.payload !== null &&
      (typeof event.payload.transitionId !== 'string' || event.payload.previousStatusKnown !== true)
    ) {
      untimestampedStatus = true;
    }
    if (event.kind === 'status') {
      const previous = statuses.get(event.session_id);
      const blocked = isBlockedStatus(event);
      const sourcePrevious =
        event.payload?.previousStatusKnown === true &&
        typeof event.payload.previousStatus === 'string'
          ? event.payload.previousStatus
          : undefined;
      const previousStatus = sourcePrevious ?? previous?.latest.status;
      const previouslyBlocked = previousStatus === 'question' || previousStatus === 'permission';
      const previouslyUnblocked =
        previousStatus === 'busy' ||
        previousStatus === 'idle' ||
        previousStatus === 'retry' ||
        previousStatus === 'scheduled';
      const historicalBlocked = previous !== undefined && isBlockedStatus(previous.latest);
      statuses.set(event.session_id, {
        latest: event,
        blockedSince: !blocked
          ? null
          : previouslyBlocked
            ? historicalBlocked
              ? (previous?.blockedSince ?? null)
              : null
            : previouslyUnblocked
              ? event
              : null,
      });
      if (at >= start && at < cutoff) {
        const group = groupFor(event.session_id);
        if (group) {
          activeRoots.add(group.sessionId);
          group.sources.push({
            id: `status:${event.id}`,
            sessionId: event.session_id,
            kind: 'activity',
            title: 'Session status changed',
            url: group.url,
            occurredAt: new Date(at).toISOString(),
          });
        }
      }
      continue;
    }
    if (at < start || at >= cutoff) continue;
    const group = groupFor(event.session_id);
    if (!group) continue;
    const source: BriefingSource = {
      id: event.id,
      sessionId: event.session_id,
      kind: 'activity',
      title: 'Session activity',
      url: group.url,
      occurredAt: new Date(at).toISOString(),
    };
    if (event.kind === 'activity' && typeof event.payload?.excerpt === 'string') {
      source.excerpt = redactBriefingExcerpt(event.payload.excerpt);
    }
    if (event.kind === 'pull_request') {
      if (!event.url || pullRequests.has(event.url)) continue;
      pullRequests.add(event.url);
      source.kind = 'pull_request';
      source.title = event.title ?? 'Opened pull request';
      source.url = event.url;
    } else if (event.kind === 'artifact') {
      if (!event.url || !event.title) continue;
      source.kind = 'artifact';
      source.title = event.title;
      source.url = event.url;
    } else if (event.kind !== 'activity') continue;
    group.sources.push(source);
    activeRoots.add(group.sessionId);
    if (event.kind === 'activity') activityRoots.add(group.sessionId);
  }
  let blockers = 0;
  for (const [sessionId, state] of statuses) {
    const since = state.blockedSince;
    if (!since || Date.parse(since.occurred_at) < start || Date.parse(since.occurred_at) >= cutoff)
      continue;
    const group = groupFor(sessionId);
    if (!group) continue;
    blockers += 1;
    activeRoots.add(group.sessionId);
    group.sources.push({
      id: since.id,
      sessionId,
      kind: 'blocker',
      title: 'Waiting for your input',
      url: group.url,
      occurredAt: new Date(since.occurred_at).toISOString(),
    });
  }
  const used = new Set<string>();
  let spendMicrodollars = 0;
  for (const item of usage) {
    const at = Date.parse(item.occurredAt);
    if (used.has(item.id) || !Number.isFinite(at) || at < start || at >= cutoff) continue;
    const group = groupFor(item.sessionId);
    if (!group) continue;
    used.add(item.id);
    group.spendMicrodollars += item.cost;
    spendMicrodollars += item.cost;
    activeRoots.add(group.sessionId);
    spendRoots.add(group.sessionId);
    group.sources.push({
      id: `usage:${item.id}`,
      sessionId: item.sessionId,
      kind: 'cost',
      title: 'Recorded usage charge',
      url: group.url,
      occurredAt: new Date(at).toISOString(),
    });
  }
  const groupStatus = new Map<string, Event>();
  for (const [sessionId, state] of statuses) {
    const root = rootById.get(sessionId);
    if (!root) continue;
    const current = groupStatus.get(root.session_id);
    const blocked = isBlockedStatus(state.latest);
    if (
      !current ||
      (blocked !== isBlockedStatus(current) ? blocked : compareEvents(state.latest, current) > 0)
    ) {
      groupStatus.set(root.session_id, state.latest);
    }
  }
  for (const group of groups.values()) {
    group.status = groupStatus.get(group.sessionId)?.status ?? null;
    group.sources.sort(
      (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id)
    );
  }
  const sessions = [...groups.values()].filter(group => activeRoots.has(group.sessionId));
  sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const sources = sessions.flatMap(session => session.sources);
  sources.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  const everyActiveSessionCharged = [...activityRoots].every(root => spendRoots.has(root));
  const coverage: BriefingEvidenceCoverage = {
    activity: collectionCovered ? 'complete' : 'partial',
    spend:
      used.size === 0
        ? collectionCovered && activityRoots.size === 0
          ? 'complete'
          : 'unavailable'
        : collectionCovered && everyActiveSessionCharged
          ? 'complete'
          : 'partial',
    blockers: collectionCovered && !untimestampedStatus ? 'complete' : 'partial',
    pullRequests: collectionCovered ? 'complete' : 'partial',
  };
  return {
    scorecard: {
      sessions: sessions.length,
      pullRequests: pullRequests.size,
      blockers,
      spendMicrodollars,
    },
    sessions,
    sources,
    coverage,
  };
}

export async function collectBriefingEvidence(
  userId: string,
  organizationId: string | null,
  nightStartAt: string,
  cutoffAt: string,
  recordedBefore?: string
) {
  const start = Date.parse(nightStartAt);
  const cutoff = Date.parse(cutoffAt);
  if (!Number.isFinite(start) || !Number.isFinite(cutoff) || start >= cutoff) {
    throw new Error('Invalid briefing evidence window');
  }
  const scope = and(
    eq(cli_sessions_v2.kilo_user_id, userId),
    organizationId === null
      ? isNull(cli_sessions_v2.organization_id)
      : eq(cli_sessions_v2.organization_id, organizationId),
    or(
      eq(cli_sessions_v2.created_on_platform, 'cli'),
      eq(cli_sessions_v2.created_on_platform, 'cloud-agent'),
      eq(cli_sessions_v2.created_on_platform, 'cloud-agent-web'),
      isNotNull(cli_sessions_v2.cloud_agent_session_id),
      isNotNull(cli_sessions_v2.cloud_agent_session_scope_id)
    )
  );
  const eventScope = and(
    eq(agent_briefing_events.kilo_user_id, userId),
    organizationId === null
      ? isNull(agent_briefing_events.organization_id)
      : eq(agent_briefing_events.organization_id, organizationId),
    recordedBefore === undefined
      ? undefined
      : lte(agent_briefing_events.recorded_at, recordedBefore)
  );
  return db.transaction(
    async tx => {
      const [preferences] = await tx
        .select({ createdAt: agent_briefing_preferences.created_at })
        .from(agent_briefing_preferences)
        .where(eq(agent_briefing_preferences.kilo_user_id, userId));
      const events = await tx
        .select()
        .from(agent_briefing_events)
        .where(
          and(
            eventScope,
            gte(agent_briefing_events.occurred_at, nightStartAt),
            lte(agent_briefing_events.occurred_at, cutoffAt)
          )
        )
        .orderBy(asc(agent_briefing_events.occurred_at), asc(agent_briefing_events.id));
      const usage = await tx
        .select({
          id: microdollar_usage.id,
          sessionId: cli_sessions_v2.session_id,
          cost: microdollar_usage.cost,
          occurredAt: microdollar_usage.created_at,
        })
        .from(microdollar_usage)
        .innerJoin(
          microdollar_usage_metadata,
          eq(microdollar_usage_metadata.id, microdollar_usage.id)
        )
        .innerJoin(
          cli_sessions_v2,
          and(
            or(
              eq(cli_sessions_v2.session_id, microdollar_usage_metadata.session_id),
              eq(cli_sessions_v2.cloud_agent_session_id, microdollar_usage_metadata.session_id)
            ),
            scope
          )
        )
        .where(
          and(
            eq(microdollar_usage.kilo_user_id, userId),
            notLike(microdollar_usage_metadata.session_id, 'agent-briefing:%'),
            organizationId === null
              ? isNull(microdollar_usage.organization_id)
              : eq(microdollar_usage.organization_id, organizationId),
            gte(microdollar_usage.created_at, nightStartAt),
            lt(microdollar_usage.created_at, cutoffAt)
          )
        );
      const activeSessionIds = [
        ...new Set([
          ...events.map(event => event.session_id),
          ...usage.map(item => item.sessionId),
        ]),
      ];
      const baseline =
        activeSessionIds.length === 0
          ? []
          : await tx
              .selectDistinctOn([agent_briefing_events.session_id])
              .from(agent_briefing_events)
              .where(
                and(
                  eventScope,
                  eq(agent_briefing_events.kind, 'status'),
                  inArray(agent_briefing_events.session_id, activeSessionIds),
                  lt(agent_briefing_events.occurred_at, nightStartAt)
                )
              )
              .orderBy(
                agent_briefing_events.session_id,
                desc(agent_briefing_events.occurred_at),
                desc(sql`coalesce(${agent_briefing_events.payload}->>'transitionId', '')`),
                desc(agent_briefing_events.id)
              );
      const rows = new Map<
        string,
        { session_id: string; parent_session_id: string | null; title: string | null }
      >();
      const requested = new Set(activeSessionIds);
      let pending = activeSessionIds;
      while (pending.length > 0) {
        const found = await tx
          .select({
            session_id: cli_sessions_v2.session_id,
            parent_session_id: cli_sessions_v2.parent_session_id,
            title: cli_sessions_v2.title,
          })
          .from(cli_sessions_v2)
          .where(and(scope, inArray(cli_sessions_v2.session_id, pending)));
        pending = [];
        for (const row of found) {
          rows.set(row.session_id, row);
          if (row.parent_session_id !== null && !requested.has(row.parent_session_id)) {
            requested.add(row.parent_session_id);
            pending.push(row.parent_session_id);
          }
        }
      }
      const [legacyStatus] = await tx
        .select({ sessionId: cli_sessions_v2.session_id })
        .from(cli_sessions_v2)
        .where(
          and(
            scope,
            isNotNull(cli_sessions_v2.status),
            isNull(cli_sessions_v2.status_transition_id),
            gte(cli_sessions_v2.updated_at, nightStartAt),
            gte(cli_sessions_v2.status_updated_at, nightStartAt),
            lt(cli_sessions_v2.status_updated_at, cutoffAt)
          )
        )
        .limit(1);
      return aggregateBriefingEvidence(
        [...rows.values()],
        [...baseline, ...events],
        usage,
        nightStartAt,
        cutoffAt,
        {
          collectionStartedAt: preferences?.createdAt ?? null,
          legacyStatusInWindow: legacyStatus !== undefined,
        }
      );
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' }
  );
}
