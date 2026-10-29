import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDrizzleClient, type DrizzleClient } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { briefingExcerptUpdate, type BriefingExcerpt } from '../../src/ingest/briefing-excerpt';

const userId = 'oauth/briefing-excerpt-test';
const sessionId = 'briefing-session';
const organizationId = '33333333-3333-4333-8333-333333333333';
const otherOrganizationId = '44444444-4444-4444-8444-444444444444';
let client: DrizzleClient;

beforeAll(async () => {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('Set POSTGRES_URL to a local test database');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('Excerpt tests require a local PostgreSQL database');
  }
  client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
  await client.db.execute(sql`
    CREATE TEMP TABLE cli_sessions_v2 (
      session_id text NOT NULL,
      kilo_user_id text NOT NULL,
      organization_id uuid,
      briefing_excerpt jsonb,
      briefing_excerpt_scope_changed_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (session_id, kilo_user_id)
    )
  `);
  await client.db.execute(sql`
    CREATE TEMP TABLE agent_briefing_context_preferences (
      kilo_user_id text NOT NULL,
      context_key text NOT NULL,
      organization_id uuid,
      enabled boolean NOT NULL,
      PRIMARY KEY (kilo_user_id, context_key)
    )
  `);
});

afterAll(async () => {
  if (client) await client.pool.end();
});

beforeEach(async () => {
  await client.db.execute(
    sql`TRUNCATE pg_temp.cli_sessions_v2, pg_temp.agent_briefing_context_preferences`
  );
  await client.db.execute(sql`
    INSERT INTO pg_temp.cli_sessions_v2 (session_id, kilo_user_id) VALUES (${sessionId}, ${userId})
  `);
});

const excerpt = (messageId: string, completedAt = '2026-10-20T08:00:00.000Z'): BriefingExcerpt => ({
  messageId,
  completedAt,
  text: `Final response from ${messageId}`,
});

async function enableContext(
  scope: string | null,
  options: { userId?: string; enabled?: boolean; contextKey?: string } = {}
) {
  await client.db.execute(sql`
    INSERT INTO pg_temp.agent_briefing_context_preferences
      (kilo_user_id, context_key, organization_id, enabled)
    VALUES (${options.userId ?? userId}, ${options.contextKey ?? scope ?? 'personal'}, ${scope}, ${options.enabled ?? true})
  `);
}

async function persist(candidate: BriefingExcerpt, receivedAtIso = candidate.completedAt) {
  const [row] = await client.db
    .update(cli_sessions_v2)
    .set({ briefing_excerpt: briefingExcerptUpdate(candidate, receivedAtIso) })
    .where(and(eq(cli_sessions_v2.session_id, sessionId), eq(cli_sessions_v2.kilo_user_id, userId)))
    .returning({ excerpt: cli_sessions_v2.briefing_excerpt });
  return row?.excerpt;
}

describe('briefing excerpt conditional persistence', () => {
  it('requires explicit enablement of the exact personal owner context', async () => {
    const candidate = excerpt('personal');
    expect(await persist(candidate)).toBeNull();
    await enableContext(null, { enabled: false });
    await enableContext(null, { userId: 'oauth/other-owner' });
    await enableContext(organizationId);
    expect(await persist(candidate)).toBeNull();
    await client.db.execute(
      sql`UPDATE pg_temp.agent_briefing_context_preferences SET enabled = true WHERE kilo_user_id = ${userId} AND context_key = 'personal'`
    );
    expect(await persist(candidate)).toEqual(candidate);
  });

  it('does not use personal or another organization enablement for an organization session', async () => {
    await client.db.execute(
      sql`UPDATE pg_temp.cli_sessions_v2 SET organization_id = ${organizationId}`
    );
    await enableContext(null);
    await enableContext(otherOrganizationId);
    await enableContext(organizationId, { userId: 'oauth/other-owner' });
    await enableContext(organizationId, { contextKey: 'mismatched-context' });
    expect(await persist(excerpt('not-eligible'))).toBeNull();
    await enableContext(organizationId, { enabled: false });
    expect(await persist(excerpt('still-disabled'))).toBeNull();
    await client.db.execute(
      sql`UPDATE pg_temp.agent_briefing_context_preferences SET enabled = true WHERE kilo_user_id = ${userId} AND context_key = ${organizationId}`
    );
    const candidate = excerpt('organization');
    expect(await persist(candidate)).toEqual(candidate);
  });

  it('uses source completion time and a deterministic source-id tie break instead of arrival time', async () => {
    await enableContext(null);
    const latest = excerpt('z-final');
    expect(await persist(latest)).toEqual(latest);
    expect(await persist(excerpt('later-arrival', '2026-10-20T07:59:00.000Z'))).toEqual(latest);
    expect(await persist(excerpt('a-final'))).toEqual(latest);
    expect(await persist({ ...latest, text: 'replayed replacement' })).toEqual(latest);
    const newer = excerpt('a-newer', '2026-10-20T08:01:00.000Z');
    expect(await persist(newer)).toEqual(newer);
  });

  it('does not resurrect an old-context response after a move or a move back', async () => {
    await enableContext(null);
    await enableContext(organizationId);
    const personal = excerpt('personal-before-move');
    expect(await persist(personal)).toEqual(personal);
    await client.db.execute(sql`
      UPDATE pg_temp.cli_sessions_v2 SET organization_id = ${organizationId}, briefing_excerpt = NULL,
        briefing_excerpt_scope_changed_at = '2026-10-20T08:01:00.000Z'
    `);
    expect(await persist(personal)).toBeNull();
    expect(await persist(excerpt('boundary', '2026-10-20T08:01:00.000Z'))).toBeNull();
    const organization = excerpt('organization-after-move', '2026-10-20T08:02:00.000Z');
    expect(await persist(organization)).toEqual(organization);
    await client.db.execute(sql`
      UPDATE pg_temp.cli_sessions_v2 SET organization_id = NULL, briefing_excerpt = NULL,
        briefing_excerpt_scope_changed_at = '2026-10-20T08:03:00.000Z'
    `);
    expect(await persist(organization)).toBeNull();
    const current = excerpt('personal-after-return', '2026-10-20T08:04:00.000Z');
    expect(await persist(current)).toEqual(current);
  });

  it('fences a response received before a scope change even when the client clock runs ahead', async () => {
    await enableContext(null);
    await client.db.execute(sql`
      UPDATE pg_temp.cli_sessions_v2 SET briefing_excerpt_scope_changed_at = '2026-10-20T08:01:00.000Z'
    `);
    const skewed = excerpt('skewed-client', '2026-10-20T08:01:30.000Z');
    expect(await persist(skewed, '2026-10-20T08:00:50.000Z')).toBeNull();
    expect(await persist(skewed, '2026-10-20T08:01:10.000Z')).toEqual(skewed);
  });

  it('does not recreate a deleted session', async () => {
    await enableContext(null);
    await client.db.execute(
      sql`DELETE FROM pg_temp.cli_sessions_v2 WHERE session_id = ${sessionId}`
    );
    expect(await persist(excerpt('deleted'))).toBeUndefined();
  });
});
