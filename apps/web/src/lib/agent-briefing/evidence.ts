import { and, asc, eq, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { sessionLiveSummarySchema } from '@kilocode/session-ingest-contracts';
import {
  BRIEFING_MAX_SESSIONS,
  BRIEFING_MAX_SNAPSHOT_BYTES,
  BRIEFING_MAX_TITLE_LENGTH,
  BRIEFING_MAX_URL_LENGTH,
  briefingReportSchema,
  redactBriefingExcerpt,
  type BriefingSource,
} from '@kilocode/app-shared/agent-briefing';

export const briefingFactsSchema = briefingReportSchema.pick({
  scorecard: true,
  sessions: true,
  sources: true,
  coverage: true,
  truncated: true,
});
const completedExcerptSchema = z.object({
  messageId: z.string(),
  completedAt: z.string().datetime(),
  text: z.string(),
});
type SnapshotSession = Pick<
  typeof cli_sessions_v2.$inferSelect,
  | 'session_id'
  | 'title'
  | 'status'
  | 'last_activity_at'
  | 'briefing_excerpt'
  | 'pr_url'
  | 'pr_link_verified_at'
  | 'live_summary'
>;

export function buildBriefingSnapshot(rows: SnapshotSession[]) {
  const facts = briefingFactsSchema.parse({
    scorecard: { sessions: 0, pullRequests: 0, blockers: 0 },
    sessions: [],
    sources: [],
    coverage: { activity: 'partial', blockers: 'partial', pullRequests: 'partial' },
    truncated: rows.length > BRIEFING_MAX_SESSIONS,
  });
  for (const row of rows.slice(0, BRIEFING_MAX_SESSIONS)) {
    if (!row.last_activity_at) continue;
    const title = redactBriefingExcerpt(row.title ?? 'Agent session', BRIEFING_MAX_TITLE_LENGTH);
    const url = `/cloud/sessions/${encodeURIComponent(row.session_id)}`;
    const occurredAt = new Date(row.last_activity_at).toISOString();
    const excerpt = completedExcerptSchema.safeParse(row.briefing_excerpt);
    const activity: BriefingSource = {
      id: `activity:${row.session_id}`,
      sessionId: row.session_id,
      kind: 'activity',
      title,
      url,
      occurredAt: excerpt.success ? new Date(excerpt.data.completedAt).toISOString() : occurredAt,
      ...(excerpt.success ? { excerpt: redactBriefingExcerpt(excerpt.data.text) } : {}),
    };
    const sources: BriefingSource[] = [activity];
    const live = sessionLiveSummarySchema.safeParse(row.live_summary);
    const blocked =
      ['question', 'permission', 'waiting_for_input', 'error'].includes(row.status ?? '') ||
      (live.success && live.data.failure !== null);
    if (blocked)
      sources.push({
        id: `blocker:${row.session_id}`,
        sessionId: row.session_id,
        kind: 'blocker',
        title: 'Session needs attention',
        url,
        occurredAt,
      });
    if (live.success && (live.data.plan || live.data.changes || live.data.failure)) {
      const metadata: string[] = [];
      if (live.data.plan) {
        const plan = live.data.plan;
        metadata.push(
          `Plan: ${plan.done} of ${plan.total} steps done${plan.current ? `; current: ${plan.current}` : ''}.`
        );
      }
      if (live.data.changes) {
        const changes = live.data.changes;
        metadata.push(
          `Changes: ${changes.files} files; ${changes.added} lines added, ${changes.removed} removed.`
        );
      }
      if (live.data.failure) metadata.push(`Last turn failure: ${live.data.failure.kind}.`);
      sources.push({
        id: `metadata:${row.session_id}`,
        sessionId: row.session_id,
        kind: 'artifact',
        title: 'Captured session metadata',
        url,
        occurredAt,
        excerpt: redactBriefingExcerpt(metadata.join('\n')),
      });
    }
    if (row.pr_url && row.pr_link_verified_at && row.pr_url.length <= BRIEFING_MAX_URL_LENGTH) {
      try {
        const pr = new URL(row.pr_url);
        if (pr.protocol === 'https:' && !pr.username && !pr.password) {
          pr.search = '';
          pr.hash = '';
          sources.push({
            id: `pr:${row.session_id}`,
            sessionId: row.session_id,
            kind: 'pull_request',
            title: 'Verified pull request',
            url: pr.toString(),
            occurredAt,
          });
        }
      } catch {
        /* Invalid stored links are not snapshot evidence. */
      }
    }
    const session = { sessionId: row.session_id, title, url, status: row.status, sources };
    facts.sessions.push(session);
    facts.sources.push(...sources);
    facts.scorecard = {
      sessions: facts.sessions.length,
      pullRequests: new Set(
        facts.sources.filter(source => source.kind === 'pull_request').map(source => source.url)
      ).size,
      blockers: facts.sources.filter(source => source.kind === 'blocker').length,
    };
    if (Buffer.byteLength(JSON.stringify(facts), 'utf8') > BRIEFING_MAX_SNAPSHOT_BYTES) {
      facts.sessions.pop();
      facts.sources.splice(facts.sources.length - sources.length, sources.length);
      facts.scorecard = {
        sessions: facts.sessions.length,
        pullRequests: new Set(
          facts.sources.filter(source => source.kind === 'pull_request').map(source => source.url)
        ).size,
        blockers: facts.sources.filter(source => source.kind === 'blocker').length,
      };
      facts.truncated = true;
      break;
    }
  }
  return briefingFactsSchema.parse(facts);
}

export async function collectBriefingSnapshot(
  userId: string,
  organizationId: string | null,
  nightStartAt: string,
  cutoffAt: string
) {
  const rows = await db
    .select({
      session_id: cli_sessions_v2.session_id,
      title: cli_sessions_v2.title,
      status: cli_sessions_v2.status,
      last_activity_at: cli_sessions_v2.last_activity_at,
      briefing_excerpt: cli_sessions_v2.briefing_excerpt,
      live_summary: cli_sessions_v2.live_summary,
      pr_url: cli_sessions_v2.pr_url,
      pr_link_verified_at: cli_sessions_v2.pr_link_verified_at,
    })
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, userId),
        organizationId
          ? eq(cli_sessions_v2.organization_id, organizationId)
          : isNull(cli_sessions_v2.organization_id),
        isNotNull(cli_sessions_v2.last_activity_at),
        gte(cli_sessions_v2.last_activity_at, nightStartAt),
        lte(cli_sessions_v2.last_activity_at, cutoffAt)
      )
    )
    // Include the nullable scope key to preserve index ordering for personal snapshots.
    .orderBy(
      asc(cli_sessions_v2.organization_id),
      sql`${cli_sessions_v2.last_activity_at} DESC NULLS LAST`,
      asc(cli_sessions_v2.session_id)
    )
    .limit(BRIEFING_MAX_SESSIONS + 1);
  return buildBriefingSnapshot(rows);
}
