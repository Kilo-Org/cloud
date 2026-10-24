import { TRPCError } from '@trpc/server';
import { redactBriefingExcerpt, type BriefingReport } from '@kilocode/app-shared/agent-briefing';

type Facts = Pick<BriefingReport, 'scorecard' | 'sessions' | 'sources' | 'coverage'> & {
  omittedCollectedSessions: number;
  omittedCollectedSources: number;
};
type FrozenFacts = Facts & {
  evidenceEventIds: string[];
  evidenceSessionIds: string[];
  evidenceUsage: { id: string; sessionId: string }[];
  collectionTruncated: boolean;
};

export const ONE_OFF_BUCKETS = 16;
export const ONE_OFF_ROWS_PER_BUCKET = 8;
export const ONE_OFF_SESSION_LIMIT = 64;
export const ONE_OFF_ANCESTRY_LIMIT = 256;
export const ONE_OFF_SNAPSHOT_BYTES = 64_000;

export function sampleBriefingItems<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  if (limit < 2) return items.slice(0, limit);
  return Array.from(
    { length: limit },
    (_, index) => items[Math.floor((index * (items.length - 1)) / (limit - 1))]
  ).filter(item => item !== undefined);
}

export function boundBriefingSlices<T extends { id: string; slice: number }>(
  rows: T[],
  compare: (a: T, b: T) => number
) {
  const groups = new Map<number, Map<string, T>>();
  for (const row of rows) {
    let group = groups.get(row.slice);
    if (!group) {
      group = new Map<string, T>();
      groups.set(row.slice, group);
    }
    group.set(row.id, row);
  }
  const records: T[] = [];
  let truncated = false;
  for (const group of groups.values()) {
    const ordered = [...group.values()].sort(compare);
    truncated ||= ordered.length > ONE_OFF_ROWS_PER_BUCKET;
    records.push(...sampleBriefingItems(ordered, ONE_OFF_ROWS_PER_BUCKET));
  }
  return { records, truncated };
}

export function freezeBriefingEvidence(
  facts: Facts,
  provenance: {
    eventIds: string[];
    sessionIds: string[];
    usage?: { id: string; sessionId: string }[];
    partial: boolean;
  }
): FrozenFacts {
  const allSources = facts.sources.map(source => ({
    ...source,
    title: redactBriefingExcerpt(source.title, 160),
  }));
  const allSessions = facts.sessions.map(session => ({
    ...session,
    title: redactBriefingExcerpt(session.title, 160),
  }));
  const evidenceUsage =
    provenance.usage ??
    facts.sources
      .filter(source => source.kind === 'cost')
      .map(source => ({
        id: source.id.slice(6),
        sessionId: source.sessionId,
      }));
  let sourceLimit = allSources.length;
  let sessionLimit = allSessions.length;
  for (;;) {
    const selectedSessions = sampleBriefingItems(allSessions, sessionLimit);
    const allowedSources = new Set(
      selectedSessions.flatMap(session => session.sources.map(source => source.id))
    );
    const sources = sampleBriefingItems(
      allSources.filter(source => allowedSources.has(source.id)),
      sourceLimit
    );
    const byId = new Map(sources.map(source => [source.id, source]));
    // The snapshot budget trims only what the report shows; counts and coverage stay whole-window.
    const display = {
      ...facts,
      sessions: selectedSessions.map(session => {
        const shown = session.sources.flatMap(source => {
          const selected = byId.get(source.id);
          return selected ? [selected] : [];
        });
        return {
          ...session,
          sources: shown,
          omittedSources: (session.omittedSources ?? 0) + session.sources.length - shown.length,
        };
      }),
      sources,
      collectionTruncated: provenance.partial,
      omittedCollectedSessions:
        facts.omittedCollectedSessions + allSessions.length - selectedSessions.length,
      omittedCollectedSources: facts.omittedCollectedSources + allSources.length - sources.length,
    } satisfies Omit<FrozenFacts, 'evidenceEventIds' | 'evidenceSessionIds' | 'evidenceUsage'>;
    // Provenance is count-bounded by the collection caps and must stay complete for access invalidation.
    const bytes = Buffer.byteLength(JSON.stringify(display), 'utf8');
    if (bytes <= ONE_OFF_SNAPSHOT_BYTES) {
      return {
        ...display,
        evidenceEventIds: provenance.eventIds,
        evidenceSessionIds: provenance.sessionIds,
        evidenceUsage,
      };
    }
    if (sourceLimit > 0) {
      sourceLimit = Math.floor((sourceLimit * ONE_OFF_SNAPSHOT_BYTES) / bytes);
    } else if (sessionLimit > 0) {
      sessionLimit = Math.floor((sessionLimit * ONE_OFF_SNAPSHOT_BYTES) / bytes);
    } else {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Selected evidence is too large to snapshot',
      });
    }
  }
}
