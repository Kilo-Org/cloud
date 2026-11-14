import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as WorkerUtils from '@kilocode/worker-utils';
import type * as SessionTitleModule from '../services/session-title';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {},
}));

vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn() }));
vi.mock('../dos/SessionAccessCacheDO', () => ({ getSessionAccessCacheDO: vi.fn() }));
vi.mock('../ingest/direct-ingest', () => ({ handleDirectIngestRequest: vi.fn() }));
vi.mock('../services/session-access', () => ({ resolveAccessibleKiloSession: vi.fn() }));
vi.mock('../services/session-export', () => ({ getSessionExport: vi.fn() }));
vi.mock('../services/session-title', async importOriginal => ({
  ...(await importOriginal<typeof SessionTitleModule>()),
  applyReportedSessionTitle: vi.fn(),
}));
vi.mock('../services/user-session-admission', () => ({
  canCreateCliSessionForUser: vi.fn(),
}));
vi.mock('../session-events', () => ({
  mapSessionEventRow: vi.fn(),
  notifyUserSessionEvent: vi.fn(),
}));

const workerUtils = vi.hoisted(() => ({ hasOrganizationAccess: vi.fn() }));
vi.mock('@kilocode/worker-utils', async importOriginal => ({
  ...(await importOriginal<typeof WorkerUtils>()),
  hasOrganizationAccess: workerUtils.hasOrganizationAccess,
}));

import { getWorkerDb } from '@kilocode/db/client';
import {
  cloudAgentSessionScopeHeaders,
  cloudAgentSessionScopeV2Headers,
} from '@kilocode/session-ingest-contracts';
import { handleDirectIngestRequest } from '../ingest/direct-ingest';
import { getSessionExport } from '../services/session-export';
import { applyReportedSessionTitle } from '../services/session-title';
import { cloudAgentSessionScopeApi } from './cloud-agent-session-scope';

// The worktree-scope module is deliberately not mocked: these requests run the
// real `resolveScopedChildSession` against a fake database, so the route's 404
// depends on the same ancestry check that guards session-ingest.
const memberRootId = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const memberRootParentId = 'ses_dddddddddddddddddddddddddd';
const outsiderId = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
const env = { HYPERDRIVE: { connectionString: 'postgres://test' } } as never;

const outsiderRow = {
  sessionId: outsiderId,
  parentSessionId: memberRootParentId,
  organizationId: null,
  cloudAgentSessionId: null,
  cloudAgentSessionScopeId: 'workspace_22222222-2222-4222-8222-222222222222',
  cloudAgentWorktreeId: worktreeId,
};

function makeApp() {
  const app = new Hono<{ Bindings: Record<string, unknown>; Variables: { user_id: string } }>();
  app.use('*', async (c, next) => {
    c.set('user_id', 'usr_test');
    await next();
  });
  app.route('/', cloudAgentSessionScopeApi);
  return app;
}

function v2Headers() {
  return {
    'Content-Type': 'application/json',
    [cloudAgentSessionScopeHeaders.protocolVersion]: '2',
    [cloudAgentSessionScopeV2Headers.worktreeId]: worktreeId,
    [cloudAgentSessionScopeV2Headers.expectedOrganization]: 'personal',
    [cloudAgentSessionScopeV2Headers.memberRootKiloSessionIds]: memberRootId,
  };
}

function makeDb(options: { sessionRows: unknown[]; ancestryRows: unknown[] }) {
  const sessionRowResults = [...options.sessionRows];
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => sessionRowResults.shift() ?? []),
  };
  const select = vi.fn(() => chain);
  const execute = vi.fn(async () => ({ rows: options.ancestryRows }));
  return { select, execute, chain };
}

describe('Cloud Agent session scope membership on the v2 route', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    workerUtils.hasOrganizationAccess.mockResolvedValue(true);
  });

  it.each([
    { name: 'ingest', method: 'POST', suffix: '/ingest', body: undefined },
    { name: 'export', method: 'GET', suffix: '/export', body: undefined },
    {
      name: 'title',
      method: 'POST',
      suffix: '/title',
      body: JSON.stringify({ title: 'Reported title', generated: false }),
    },
  ])(
    'answers 404 for $name of a session whose ancestry misses the member root, without writing',
    async ({ method, suffix, body }) => {
      const fake = makeDb({ sessionRows: [[outsiderRow]], ancestryRows: [] });
      vi.mocked(getWorkerDb).mockReturnValue(fake as never);

      const response = await makeApp().fetch(
        new Request(`http://local/session/${outsiderId}${suffix}`, {
          method,
          headers: v2Headers(),
          ...(body === undefined ? {} : { body }),
        }),
        env
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: 'session_not_found',
      });
      // The child lookup found a row in the asserted worktree, so the denial is
      // the ancestry re-derivation and not an earlier shape check.
      expect(fake.chain.limit).toHaveBeenCalled();
      expect(fake.execute).toHaveBeenCalled();
      expect(handleDirectIngestRequest).not.toHaveBeenCalled();
      expect(getSessionExport).not.toHaveBeenCalled();
      expect(applyReportedSessionTitle).not.toHaveBeenCalled();
    }
  );

  it.each([
    { name: 'ingest', method: 'POST', suffix: '/ingest', body: undefined },
    { name: 'export', method: 'GET', suffix: '/export', body: undefined },
    {
      name: 'title',
      method: 'POST',
      suffix: '/title',
      body: JSON.stringify({ title: 'Reported title', generated: false }),
    },
  ])(
    'answers 404 for $name of a session outside the asserted worktree',
    async ({ method, suffix, body }) => {
      const fake = makeDb({ sessionRows: [[]], ancestryRows: [] });
      vi.mocked(getWorkerDb).mockReturnValue(fake as never);

      const response = await makeApp().fetch(
        new Request(`http://local/session/${outsiderId}${suffix}`, {
          method,
          headers: v2Headers(),
          ...(body === undefined ? {} : { body }),
        }),
        env
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: 'session_not_found',
      });
      expect(handleDirectIngestRequest).not.toHaveBeenCalled();
      expect(getSessionExport).not.toHaveBeenCalled();
      expect(applyReportedSessionTitle).not.toHaveBeenCalled();
    }
  );
});
