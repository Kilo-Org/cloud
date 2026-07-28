import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as WorkerUtils from '@kilocode/worker-utils';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {},
}));

vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn() }));
vi.mock('../dos/SessionAccessCacheDO', () => ({ getSessionAccessCacheDO: vi.fn() }));
vi.mock('../ingest/direct-ingest', () => ({ handleDirectIngestRequest: vi.fn() }));
vi.mock('../services/session-access', () => ({ resolveAccessibleKiloSession: vi.fn() }));
vi.mock('../session-events', () => ({
  mapSessionEventRow: vi.fn(row => ({ id: row.session_id, updatedAt: row.updated_at })),
  notifyUserSessionEvent: vi.fn(),
}));

const workerUtils = vi.hoisted(() => ({ hasOrganizationAccess: vi.fn() }));
vi.mock('@kilocode/worker-utils', async importOriginal => ({
  ...(await importOriginal<typeof WorkerUtils>()),
  hasOrganizationAccess: workerUtils.hasOrganizationAccess,
}));

import { getWorkerDb } from '@kilocode/db/client';
import { cloudAgentFamilyHeaders } from '@kilocode/session-ingest-contracts';
import { getSessionAccessCacheDO } from '../dos/SessionAccessCacheDO';
import { handleDirectIngestRequest } from '../ingest/direct-ingest';
import { resolveAccessibleKiloSession } from '../services/session-access';
import { cloudAgentFamilyApi } from './cloud-agent-family';

const rootSessionId = 'ses_12345678901234567890123456';
const childSessionId = 'ses_abcdefghijklmnopqrstuvwxyz';
const cloudAgentSessionId = 'cloud-agent-session-1';
const env = { HYPERDRIVE: { connectionString: 'postgres://test' } } as never;

function makeApp() {
  const app = new Hono<{ Bindings: Record<string, unknown>; Variables: { user_id: string } }>();
  app.use('*', async (c, next) => {
    c.set('user_id', 'usr_test');
    await next();
  });
  app.route('/', cloudAgentFamilyApi);
  return app;
}

function assertionHeaders() {
  return {
    'Content-Type': 'application/json',
    [cloudAgentFamilyHeaders.cloudAgentSessionId]: cloudAgentSessionId,
    [cloudAgentFamilyHeaders.rootKiloSessionId]: rootSessionId,
    [cloudAgentFamilyHeaders.protocolVersion]: '1',
  };
}

function persistedRow(overrides: Record<string, unknown> = {}) {
  return {
    session_id: childSessionId,
    kilo_user_id: 'usr_test',
    parent_session_id: rootSessionId,
    organization_id: '11111111-1111-4111-8111-111111111111',
    cloud_agent_session_id: null,
    cloud_agent_family_id: cloudAgentSessionId,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    title: null,
    created_on_platform: 'unknown',
    git_url: null,
    git_branch: null,
    status: null,
    status_updated_at: null,
    ...overrides,
  };
}

function makeDb(selectResults: unknown[][], insertResult: unknown[]) {
  const updateSets: unknown[] = [];
  const insertedValues: unknown[] = [];

  const select = {
    from: vi.fn(() => select),
    where: vi.fn(() => select),
    limit: vi.fn(() => select),
    for: vi.fn(async () => selectResults.shift() ?? []),
  };
  const update = {
    set: vi.fn(values => {
      updateSets.push(values);
      return update;
    }),
    where: vi.fn(() => update),
    then: vi.fn(resolve => resolve(undefined)),
  };
  const insert = {
    values: vi.fn(values => {
      insertedValues.push(values);
      return insert;
    }),
    onConflictDoNothing: vi.fn(() => insert),
    returning: vi.fn(async () => insertResult),
  };
  const tx = {
    select: vi.fn(() => select),
    update: vi.fn(() => update),
    insert: vi.fn(() => insert),
  };
  const db = {
    transaction: vi.fn(async callback => callback(tx)),
  };
  return { db, insertedValues, updateSets };
}

describe('Cloud Agent family routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    workerUtils.hasOrganizationAccess.mockResolvedValue(true);
  });

  it('atomically heals the root and creates a family child', async () => {
    const child = persistedRow();
    const { db, insertedValues, updateSets } = makeDb(
      [
        [
          {
            sessionId: rootSessionId,
            organizationId: child.organization_id,
            cloudAgentFamilyId: null,
          },
        ],
      ],
      [child]
    );
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const putValidated = vi.fn(async () => undefined);
    vi.mocked(getSessionAccessCacheDO).mockReturnValue({ putValidated } as never);

    const response = await makeApp().fetch(
      new Request('http://local/session', {
        method: 'POST',
        headers: assertionHeaders(),
        body: JSON.stringify({ sessionId: childSessionId }),
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(updateSets).toContainEqual({ cloud_agent_family_id: cloudAgentSessionId });
    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        session_id: childSessionId,
        parent_session_id: rootSessionId,
        cloud_agent_family_id: cloudAgentSessionId,
        cloud_agent_session_id: null,
      })
    );
    expect(putValidated).toHaveBeenCalledWith({
      sessionId: childSessionId,
      organizationId: child.organization_id,
      cloudAgentFamilyId: cloudAgentSessionId,
    });
  });

  it('does not claim an existing unmarked session', async () => {
    const { db } = makeDb(
      [
        [
          {
            sessionId: rootSessionId,
            organizationId: null,
            cloudAgentFamilyId: cloudAgentSessionId,
          },
        ],
        [persistedRow({ cloud_agent_family_id: null })],
      ],
      []
    );
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const response = await makeApp().fetch(
      new Request('http://local/session', {
        method: 'POST',
        headers: assertionHeaders(),
        body: JSON.stringify({ sessionId: childSessionId }),
      }),
      env
    );

    expect(response.status).toBe(409);
  });

  it('treats an existing same-family child as an idempotent bootstrap', async () => {
    const existing = persistedRow();
    const { db } = makeDb(
      [
        [
          {
            sessionId: rootSessionId,
            organizationId: null,
            cloudAgentFamilyId: cloudAgentSessionId,
          },
        ],
        [existing],
      ],
      []
    );
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const putValidated = vi.fn(async () => undefined);
    vi.mocked(getSessionAccessCacheDO).mockReturnValue({ putValidated } as never);

    const response = await makeApp().fetch(
      new Request('http://local/session', {
        method: 'POST',
        headers: assertionHeaders(),
        body: JSON.stringify({ sessionId: childSessionId }),
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(putValidated).toHaveBeenCalledWith(
      expect.objectContaining({ cloudAgentFamilyId: cloudAgentSessionId })
    );
  });

  it('requires the asserted family during child ingest authorization', async () => {
    vi.mocked(resolveAccessibleKiloSession).mockResolvedValue({
      kiloSessionId: childSessionId,
      organizationId: null,
      cloudAgentFamilyId: cloudAgentSessionId,
    });
    vi.mocked(handleDirectIngestRequest).mockResolvedValue({
      status: 200,
      body: { success: true },
    } as never);

    const response = await makeApp().fetch(
      new Request(`http://local/session/${childSessionId}/ingest?v=2`, {
        method: 'POST',
        headers: assertionHeaders(),
        body: JSON.stringify({ data: [] }),
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(resolveAccessibleKiloSession).toHaveBeenCalledWith(expect.anything(), {
      kiloUserId: 'usr_test',
      kiloSessionId: childSessionId,
      expectedCloudAgentFamilyId: cloudAgentSessionId,
    });
  });
});
