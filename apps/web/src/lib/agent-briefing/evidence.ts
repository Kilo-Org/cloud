import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  isNull,
  isNotNull,
  lt,
  lte,
  notLike,
  or,
  sql,
} from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/pg-core';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  agent_briefing_events,
  agent_briefing_preferences,
  cli_sessions_v2,
  microdollar_usage,
  microdollar_usage_metadata,
} from '@kilocode/db/schema';
import {
  BRIEFING_MAX_SESSIONS,
  BRIEFING_MAX_SOURCES,
  BRIEFING_MAX_SOURCES_PER_SESSION,
  BRIEFING_MAX_TITLE_LENGTH,
  BRIEFING_MAX_URL_LENGTH,
  BRIEFING_MAX_EXCERPT_LENGTH,
  redactBriefingExcerpt,
  type BriefingSource,
} from '@kilocode/app-shared/agent-briefing';
import {
  boundBriefingSlices,
  freezeBriefingEvidence,
  ONE_OFF_ANCESTRY_LIMIT,
  ONE_OFF_BUCKETS,
  ONE_OFF_ROWS_PER_BUCKET,
  ONE_OFF_SESSION_LIMIT,
  sampleBriefingItems,
} from './one-off-evidence';

export const BRIEFING_MAX_EVENT_ROWS = 2048;
export const BRIEFING_MAX_USAGE_ROWS = 2048;
const BRIEFING_MAX_ACTIVE_SESSIONS = 256;
const BRIEFING_MAX_ANCESTRY_ROWS = 256;

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
  truncated?: boolean;
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
  let truncated = coverageContext.truncated === true;
  const boundedText = (value: string, limit: number) => {
    truncated ||= value.length > limit;
    return value.slice(0, limit);
  };
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
        title: boundedText(root.title ?? 'Coding session', BRIEFING_MAX_TITLE_LENGTH),
        url: boundedText(
          `/cloud/sessions/${encodeURIComponent(root.session_id)}`,
          BRIEFING_MAX_URL_LENGTH
        ),
        status: null,
        spendMicrodollars: 0,
        sources: [],
      };
      groups.set(root.session_id, group);
    }
    return group;
  };
  const addSource = (group: { sources: BriefingSource[] }, source: BriefingSource) => {
    source.title = boundedText(source.title, BRIEFING_MAX_TITLE_LENGTH);
    source.url = boundedText(source.url, BRIEFING_MAX_URL_LENGTH);
    group.sources.push(source);
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
          addSource(group, {
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
      truncated ||= event.payload.excerpt.length > BRIEFING_MAX_EXCERPT_LENGTH;
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
    addSource(group, source);
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
    addSource(group, {
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
    addSource(group, {
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
    truncated ||= group.sources.length > BRIEFING_MAX_SOURCES_PER_SESSION;
    group.sources = sampleBriefingItems(group.sources, BRIEFING_MAX_SOURCES_PER_SESSION);
  }
  const activeSessions = [...groups.values()].filter(group => activeRoots.has(group.sessionId));
  activeSessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const sessions = activeSessions.slice(0, BRIEFING_MAX_SESSIONS);
  truncated ||= sessions.length !== activeSessions.length;
  const allSources = sessions.flatMap(session => session.sources);
  allSources.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  const sources = sampleBriefingItems(allSources, BRIEFING_MAX_SOURCES);
  truncated ||= sources.length !== allSources.length;
  const selectedSources = new Set(sources);
  for (const session of sessions) {
    session.sources = session.sources.filter(source => selectedSources.has(source));
    if (
      coverageContext.truncated &&
      session.status !== 'question' &&
      session.status !== 'permission'
    ) {
      session.status = null;
    }
  }
  const everyActiveSessionCharged = [...activityRoots].every(root => spendRoots.has(root));
  const coverage: BriefingEvidenceCoverage = {
    activity: collectionCovered && !truncated ? 'complete' : 'partial',
    spend:
      used.size === 0
        ? collectionCovered && activityRoots.size === 0
          ? truncated
            ? 'partial'
            : 'complete'
          : 'unavailable'
        : collectionCovered && everyActiveSessionCharged && !truncated
          ? 'complete'
          : 'partial',
    blockers: collectionCovered && !untimestampedStatus && !truncated ? 'complete' : 'partial',
    pullRequests: collectionCovered && !truncated ? 'complete' : 'partial',
  };
  return {
    scorecard: {
      sessions: activeSessions.length,
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
  recordedBefore?: string,
  freeze = false
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
      const sliceCount = freeze ? ONE_OFF_BUCKETS : 1;
      const ranges = Array.from({ length: sliceCount }, (_, slice) => ({
        slice,
        startAt: new Date(start + ((cutoff - start) * slice) / sliceCount).toISOString(),
        endAt: new Date(start + ((cutoff - start) * (slice + 1)) / sliceCount).toISOString(),
      }));
      const eventQueries = ranges.flatMap(range => {
        const query = (reverse: boolean) => {
          const order = reverse ? desc : asc;
          return tx
            .select({
              ...getTableColumns(agent_briefing_events),
              slice: sql<number>`${range.slice}::integer`.as('slice'),
            })
            .from(agent_briefing_events)
            .where(
              and(
                eventScope,
                gte(agent_briefing_events.occurred_at, range.startAt),
                lt(agent_briefing_events.occurred_at, range.endAt)
              )
            )
            .orderBy(order(agent_briefing_events.occurred_at), order(agent_briefing_events.id));
        };
        return freeze
          ? [
              query(false).limit(ONE_OFF_ROWS_PER_BUCKET / 2 + 1),
              query(true).limit(ONE_OFF_ROWS_PER_BUCKET / 2 + 1),
            ]
          : [query(false).limit(BRIEFING_MAX_EVENT_ROWS + 1)];
      });
      const [firstEvents, secondEvents, ...remainingEvents] = eventQueries;
      if (firstEvents === undefined) throw new Error('Missing briefing event range');
      const eventRows =
        secondEvents !== undefined
          ? await unionAll(firstEvents, secondEvents, ...remainingEvents)
          : await firstEvents;
      const eventSample = freeze
        ? boundBriefingSlices(eventRows, compareEvents)
        : {
            records: eventRows.slice(0, BRIEFING_MAX_EVENT_ROWS),
            truncated: eventRows.length > BRIEFING_MAX_EVENT_ROWS,
          };
      const events = eventSample.records;
      const usageQueries = ranges.flatMap(range => {
        const query = (reverse: boolean) => {
          const order = reverse ? desc : asc;
          return tx
            .select({
              id: microdollar_usage.id,
              sessionId: cli_sessions_v2.session_id,
              cost: microdollar_usage.cost,
              occurredAt: microdollar_usage.created_at,
              slice: sql<number>`${range.slice}::integer`.as('slice'),
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
                gte(microdollar_usage.created_at, range.startAt),
                lt(microdollar_usage.created_at, range.endAt)
              )
            )
            .orderBy(order(microdollar_usage.created_at), order(microdollar_usage.id));
        };
        return freeze
          ? [
              query(false).limit(ONE_OFF_ROWS_PER_BUCKET / 2 + 1),
              query(true).limit(ONE_OFF_ROWS_PER_BUCKET / 2 + 1),
            ]
          : [query(false).limit(BRIEFING_MAX_USAGE_ROWS + 1)];
      });
      const [firstUsage, secondUsage, ...remainingUsage] = usageQueries;
      if (firstUsage === undefined) throw new Error('Missing briefing usage range');
      const usageRows =
        secondUsage !== undefined
          ? await unionAll(firstUsage, secondUsage, ...remainingUsage)
          : await firstUsage;
      const usageSample = freeze
        ? boundBriefingSlices(
            usageRows,
            (a, b) =>
              Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id)
          )
        : {
            records: usageRows.slice(0, BRIEFING_MAX_USAGE_ROWS),
            truncated: usageRows.length > BRIEFING_MAX_USAGE_ROWS,
          };
      const usage = usageSample.records;
      const activity = [
        ...events.map(event => ({ sessionId: event.session_id, occurredAt: event.occurred_at })),
        ...usage.map(item => ({ sessionId: item.sessionId, occurredAt: item.occurredAt })),
      ].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
      const allActiveSessionIds = [...new Set(activity.map(item => item.sessionId))];
      const activeSessionIds = freeze
        ? sampleBriefingItems(allActiveSessionIds, ONE_OFF_SESSION_LIMIT)
        : allActiveSessionIds.slice(0, BRIEFING_MAX_ACTIVE_SESSIONS);
      let truncated =
        eventSample.truncated ||
        usageSample.truncated ||
        activeSessionIds.length !== allActiveSessionIds.length;
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
                  sql`${agent_briefing_events.session_id} = ANY(${sql.param(activeSessionIds)}::text[])`,
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
      const queried = new Set<string>();
      let pending = activeSessionIds;
      while (pending.length > 0) {
        const ancestryLimit = freeze ? ONE_OFF_ANCESTRY_LIMIT : BRIEFING_MAX_ANCESTRY_ROWS;
        const queryIds = pending.slice(0, Math.max(0, ancestryLimit - queried.size));
        if (queryIds.length === 0) {
          truncated = true;
          break;
        }
        for (const id of queryIds) queried.add(id);
        const found = await tx
          .select({
            session_id: cli_sessions_v2.session_id,
            parent_session_id: cli_sessions_v2.parent_session_id,
            title: cli_sessions_v2.title,
          })
          .from(cli_sessions_v2)
          .where(
            and(scope, sql`${cli_sessions_v2.session_id} = ANY(${sql.param(queryIds)}::text[])`)
          );
        pending = pending.slice(queryIds.length);
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
      const completeRows = [...rows.values()].filter(row => {
        let current = row;
        const seen = new Set([row.session_id]);
        while (current.parent_session_id) {
          const parent = rows.get(current.parent_session_id);
          if (!parent) return queried.has(current.parent_session_id);
          if (seen.has(parent.session_id)) return false;
          seen.add(parent.session_id);
          current = parent;
        }
        return true;
      });
      truncated ||= completeRows.length !== rows.size;
      const latest =
        freeze && completeRows.length > 0
          ? await tx
              .selectDistinctOn([agent_briefing_events.session_id])
              .from(agent_briefing_events)
              .where(
                and(
                  eventScope,
                  eq(agent_briefing_events.kind, 'status'),
                  sql`${agent_briefing_events.session_id} = ANY(${sql.param(completeRows.map(row => row.session_id))}::text[])`,
                  lte(agent_briefing_events.occurred_at, cutoffAt)
                )
              )
              .orderBy(
                agent_briefing_events.session_id,
                desc(agent_briefing_events.occurred_at),
                desc(sql`coalesce(${agent_briefing_events.payload}->>'transitionId', '')`),
                desc(agent_briefing_events.id)
              )
          : [];
      const allEvents = [...baseline, ...events, ...latest];
      const facts = aggregateBriefingEvidence(
        completeRows,
        allEvents,
        usage,
        nightStartAt,
        cutoffAt,
        {
          collectionStartedAt: preferences?.createdAt ?? null,
          legacyStatusInWindow: legacyStatus !== undefined,
          truncated,
        }
      );
      if (!freeze) return facts;
      const readableSessions = new Set(completeRows.map(row => row.session_id));
      return freezeBriefingEvidence(facts, {
        eventIds: [
          ...new Set(
            allEvents.filter(event => readableSessions.has(event.session_id)).map(event => event.id)
          ),
        ],
        sessionIds: [...readableSessions],
        usage: usage
          .filter(item => readableSessions.has(item.sessionId))
          .map(item => ({
            id: item.id,
            sessionId: item.sessionId,
          })),
        partial: truncated,
      });
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' }
  );
}
