import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerDb } from '@kilocode/db/client';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { TRPCContext } from '../../types.js';

const { access, getPgDb } = vi.hoisted(() => ({ access: vi.fn(), getPgDb: vi.fn() }));
vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));
vi.mock('../../session-access.js', () => ({ requireCurrentSessionAccess: access }));
vi.mock('../../db/pg.js', () => ({ getPgDb }));

import { router } from '../auth.js';
import { createSessionManagementHandlers } from './session-management.js';
import { parseSessionMetadata } from '../../persistence/session-metadata.js';
import { getSessionAuxiliaryMetadata } from '../../session/session-auxiliary-metadata.js';

const sessionId = 'workspace_12345678-1234-1234-1234-123456789abc';
const kiloSessionId = 'ses_native';
const userId = 'oauth/user';
const timestamp = '2026-04-29 01:16:12.945+00';
const input = { userId, cloudAgentSessionId: sessionId, kiloSessionId, organizationId: null };

function catalogRow() {
  return {
    createdOnPlatform: 'cloud-agent-web',
    profileId: 'profile-123',
    session: {
      platform: 'github' as string | null,
      pr_url: 'https://github.com/acme/repo/pull/7' as string | null,
      pr_number: 7 as number | null,
      pr_link_verified_at: timestamp as string | null,
      updated_at: timestamp,
    },
    pr_url: 'https://github.com/acme/repo/pull/7' as string | null,
    pr_number: 7 as number | null,
    pr_state: 'open' as string | null,
    pr_title: 'Verified pull request',
    pr_head_sha: 'abc123',
    pr_last_synced_at: timestamp as string | null,
    pr_review_decision: 'approved' as string | null,
    review_decision_pending: false,
  };
}

function database(rows = [catalogRow()]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const leftJoin = vi.fn().mockReturnValue({ where });
  const from = vi.fn().mockReturnValue({ leftJoin });
  const select = vi.fn().mockReturnValue({ from });
  const db = { select } as unknown as WorkerDb;
  return { db, select, leftJoin, where, limit };
}

function setup(createdOnPlatform: string | undefined = 'slack', id = sessionId) {
  const metadata = parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: { sessionId: id, userId, createdOnPlatform },
    auth: { kiloSessionId },
    workspace: { sandboxId: 'ses-0123456789abcdef0123456789abcdef' },
    lifecycle: { timestamp: 1, version: 1 },
  });
  const stub = {
    getMetadata: vi.fn().mockResolvedValue(metadata),
    getSession: vi.fn().mockResolvedValue({
      type: 'found',
      messages: [],
      route: { state: 'ready' },
      latestEventId: 5,
      updateCursor: 9,
      title: 'Native title',
      totalCostMicrodollars: 123456,
    }),
    getCurrentMessageWork: vi.fn().mockResolvedValue(null),
    getLatestEventId: vi.fn().mockResolvedValue(null),
  };
  const session = { idFromName: vi.fn(name => name), get: vi.fn(() => stub) };
  const ingest = { fetch: vi.fn() };
  const context = {
    userId,
    authToken: 'test-token',
    request: new Request('https://worker.test/trpc'),
    env: { SANDBOX_SESSION: session, CLOUD_AGENT_SESSION: session, SESSION_INGEST: ingest },
  } as unknown as TRPCContext;
  const caller = router(createSessionManagementHandlers()).createCaller(context);
  return { stub, session, ingest, caller };
}

beforeEach(() => {
  vi.clearAllMocks();
  access.mockResolvedValue({ kiloSessionId, organizationId: null });
  getPgDb.mockReturnValue(database().db);
});

describe('getSession safe auxiliary metadata', () => {
  it('preserves safe auxiliary metadata alongside DO title and cost', async () => {
    const harness = setup();
    const result = await harness.caller.getSession({ cloudAgentSessionId: sessionId });
    expect(result).toMatchObject({
      createdOnPlatform: 'slack',
      profileId: 'profile-123',
      title: 'Native title',
      totalCostMicrodollars: 123456,
      updateCursor: 9,
      associatedPr: {
        url: 'https://github.com/acme/repo/pull/7',
        number: 7,
        state: 'open',
        reviewDecision: 'approved',
        lastSyncedAt: '2026-04-29T01:16:12.945Z',
      },
    });
    expect(harness.ingest.fetch).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('auth');
    expect(result).not.toHaveProperty('session');
  });

  it('uses catalog origin only when grouped metadata does not contain it', async () => {
    const harness = setup();
    const metadata = await harness.stub.getMetadata();
    delete metadata.identity.createdOnPlatform;
    const result = await harness.caller.getSession({ cloudAgentSessionId: sessionId });
    expect(result.createdOnPlatform).toBe('cloud-agent-web');
  });

  it.each(['connection', 'query'])(
    'preserves DO state when the optional PG %s fails',
    async stage => {
      if (stage === 'connection') {
        getPgDb.mockImplementationOnce(() => {
          throw new Error('database unavailable');
        });
      } else {
        const mock = database();
        mock.limit.mockRejectedValueOnce(new Error('query unavailable'));
        getPgDb.mockReturnValueOnce(mock.db);
      }
      const harness = setup();
      const result = await harness.caller.getSession({ cloudAgentSessionId: sessionId });
      expect(result).toMatchObject({
        sessionId,
        createdOnPlatform: 'slack',
        title: 'Native title',
        totalCostMicrodollars: 123456,
        updateCursor: 9,
      });
      expect(result.profileId).toBeUndefined();
      expect(result.associatedPr).toBeUndefined();
    }
  );

  it('authorizes before any metadata enrichment or DO reads', async () => {
    access.mockRejectedValueOnce(new Error('access denied'));
    const harness = setup();
    await expect(harness.caller.getSession({ cloudAgentSessionId: sessionId })).rejects.toThrow(
      'access denied'
    );
    expect(getPgDb).not.toHaveBeenCalled();
    expect(harness.stub.getMetadata).not.toHaveBeenCalled();
  });

  it('does not add a catalog read to legacy sessions', async () => {
    const id = 'agent_12345678-1234-1234-1234-123456789abc';
    const harness = setup('slack', id);
    await harness.caller.getSession({ cloudAgentSessionId: id });
    expect(getPgDb).not.toHaveBeenCalled();
    expect(harness.stub.getSession).not.toHaveBeenCalled();
  });
});

describe('getSessionAuxiliaryMetadata', () => {
  it('returns null for a missing exact ownership row', async () => {
    await expect(getSessionAuxiliaryMetadata(database([]).db, input)).resolves.toBeNull();
  });

  it.each([null, 'org-123'])('pins catalog and PR cache to tenant %s', async orgId => {
    const mock = database();
    await getSessionAuxiliaryMetadata(mock.db, { ...input, organizationId: orgId });
    const query = new PgDialect().sqlToQuery(mock.where.mock.calls[0][0] as SQL);
    expect(query.params).toEqual([userId, kiloSessionId, sessionId, ...(orgId ? [orgId] : [])]);
    expect(query.sql).toContain('"cli_sessions_v2"."organization_id"');
    expect(query.sql).toContain(orgId === null ? 'is null' : '= $4');
    const join = new PgDialect().sqlToQuery(mock.leftJoin.mock.calls[0][1] as SQL).sql;
    expect(join).toContain(
      '"github_branch_pull_requests"."pr_number" = "cli_sessions_v2"."pr_number"'
    );
    expect(join).toContain('"owned_by_organization_id" = "cli_sessions_v2"."organization_id"');
    expect(join).toContain('"owned_by_user_id" = "cli_sessions_v2"."kilo_user_id"');
    expect(join).toContain('"cli_sessions_v2"."organization_id" is null');
    expect(join).toContain('"cli_sessions_v2"."pr_link_verified_at" is not null');
    expect(join).not.toContain('git_branch');
    expect(mock.limit).toHaveBeenCalledWith(1);
  });

  it.each(['pr_url', 'pr_link_verified_at'] as const)(
    'hides PRs without session %s',
    async field => {
      const row = catalogRow();
      row.session[field] = null;
      const result = await getSessionAuxiliaryMetadata(database([row]).db, input);
      expect(result?.associatedPr).toBeNull();
    }
  );

  it.each([
    'https://github.com/ACME/REPO/pull/7/files?view=1#diff',
    'ssh://git@github.com/acme/repo/pull/7',
    'git@github.com:acme/repo/pull/7',
  ])('matches verified PR identity %s', async url => {
    const row = catalogRow();
    row.session.pr_url = url;
    const result = await getSessionAuxiliaryMetadata(database([row]).db, input);
    expect(result?.associatedPr?.state).toBe('open');
  });

  it.each([null, 'https://github.com/acme/repo/pull/8', 'https://example.com/acme/repo/pull/7'])(
    'never borrows another PR cache and returns only its verified pending link: %s',
    async url => {
      const row = catalogRow();
      row.pr_url = url;
      const result = await getSessionAuxiliaryMetadata(database([row]).db, input);
      expect(result?.associatedPr).toMatchObject({
        url: row.session.pr_url,
        number: 7,
        state: 'unknown',
        title: null,
        headSha: null,
        reviewDecision: null,
        reviewDecisionPending: true,
        lastSyncedAt: '2026-04-29T01:16:12.945Z',
      });
    }
  );

  it.each(['pr_number', 'pr_state', 'pr_last_synced_at'] as const)(
    'omits incomplete matching cache field %s',
    async field => {
      const row = catalogRow();
      row[field] = null;
      const result = await getSessionAuxiliaryMetadata(database([row]).db, input);
      expect(result?.associatedPr).toBeNull();
    }
  );

  it.each(['approved', 'changes_requested', 'review_required', 'unexpected', null])(
    'allowlists cached review decision %s',
    async decision => {
      const row = catalogRow();
      row.pr_review_decision = decision;
      const result = await getSessionAuxiliaryMetadata(database([row]).db, input);
      expect(result?.associatedPr?.reviewDecision).toBe(
        decision === 'unexpected' ? null : decision
      );
    }
  );
});
