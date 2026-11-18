import { GetObjectCommand } from '@aws-sdk/client-s3';
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { strFromU8, unzipSync } from 'fflate';
import {
  kilocode_users,
  microdollar_usage,
  microdollar_usage_metadata,
  type User,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import type { FailureResult } from '@kilocode/web-shared/lib/maybe-result';
import type { FakeR2ClientModule } from '@kilocode/web-shared/tests/helpers/fake-r2.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { recordAdminAction } from '@/lib/admin/admin-action-audit';
import { GET } from './route';

jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server');
  return { ...actual, connection: jest.fn() };
});

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));

jest.mock('@/lib/admin/admin-action-audit', () => ({
  ...jest.requireActual('@/lib/admin/admin-action-audit'),
  recordAdminAction: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@kilocode/web-shared/lib/r2/create-client', () =>
  jest
    .requireActual<{
      createFakeR2ClientModule: () => FakeR2ClientModule;
    }>('@kilocode/web-shared/tests/helpers/fake-r2.helper')
    .createFakeR2ClientModule()
);

const { fakeR2 } = jest.requireMock<FakeR2ClientModule>(
  '@kilocode/web-shared/lib/r2/create-client'
);
const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedRecordAdminAction = jest.mocked(recordAdminAction);
const TEST_USER_ID = 'provider-metadata-download-test-user';
const BUCKET = 'test-ai-provider-metadata';
const ROUTE_BATCH_SIZE = 50;

const baseRow = {
  kilo_user_id: TEST_USER_ID,
  cost: 1,
  input_tokens: 1,
  output_tokens: 1,
  cache_write_tokens: 0,
  cache_hit_tokens: 0,
  created_at: '2026-08-01T12:00:00.000Z',
  model: 'anthropic/claude-sonnet-4.5',
};

type UsageRow = Partial<typeof microdollar_usage.$inferInsert>;

async function insertUsage(rows: UsageRow[], { withMetadata = true } = {}) {
  const inserted = await db
    .insert(microdollar_usage)
    .values(rows.map(row => ({ ...baseRow, ...row })))
    .returning({ id: microdollar_usage.id, created_at: microdollar_usage.created_at });
  if (withMetadata) {
    for (const row of inserted) {
      fakeR2.objects.set(`${BUCKET}/${row.id}.json`, JSON.stringify({ usage_id: row.id }));
    }
  }
  return inserted;
}

function createRequest(overrides: Record<string, string> = {}) {
  const params = new URLSearchParams({
    userId: TEST_USER_ID,
    startDate: '2026-08-01',
    endDate: '2026-08-01',
    ...overrides,
  });
  return new NextRequest(`http://localhost:3000/admin/api/provider-metadata/download?${params}`);
}

async function download(overrides: Record<string, string> = {}) {
  const response = await GET(createRequest(overrides));
  expect(response.status).toBe(200);
  return unzipSync(new Uint8Array(await response.arrayBuffer()));
}

function exportedIds(entries: Record<string, Uint8Array>) {
  return Object.keys(entries)
    .map(name => name.match(/_([0-9a-f-]{36})\.json$/)?.[1])
    .filter(id => id !== undefined);
}

describe('GET /admin/api/provider-metadata/download', () => {
  let admin: User;
  let plainAdmin: User;

  beforeEach(async () => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      R2_ACCOUNT_ID: 'test-metadata-account',
      R2_AI_PROVIDER_METADATA_BUCKET_NAME: BUCKET,
      R2_AI_PROVIDER_METADATA_ACCESS_KEY_ID: 'test-metadata-access-key',
      R2_AI_PROVIDER_METADATA_SECRET_ACCESS_KEY: 'test-metadata-secret-key',
    });
    mockedRecordAdminAction.mockClear();
    fakeR2.objects.clear();
    admin = await insertTestUser({ is_admin: true, can_export_api_request_logs: true });
    plainAdmin = await insertTestUser({ is_admin: true });
    mockedGetUserFromAuth.mockResolvedValue({ user: admin, authFailedResponse: null });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    const usageIds = db
      .select({ id: microdollar_usage.id })
      .from(microdollar_usage)
      .where(eq(microdollar_usage.kilo_user_id, TEST_USER_ID));
    await db
      .delete(microdollar_usage_metadata)
      .where(inArray(microdollar_usage_metadata.id, usageIds));
    await db.delete(microdollar_usage).where(eq(microdollar_usage.kilo_user_id, TEST_USER_ID));
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, [admin.id, plainAdmin.id]));
  });

  it('returns the auth failure without reading rows or auditing', async () => {
    const authFailedResponse = NextResponse.json<FailureResult<string>>(
      { success: false, error: 'Unauthorized' },
      { status: 401 }
    );
    mockedGetUserFromAuth.mockResolvedValue({ user: null, authFailedResponse });
    const send = jest.spyOn(fakeR2, 'send');

    const response = await GET(createRequest());

    expect(response).toBe(authFailedResponse);
    expect(send).not.toHaveBeenCalled();
    expect(mockedRecordAdminAction).not.toHaveBeenCalled();
  });

  it('requires export access, not base admin, before reading rows or objects', async () => {
    await insertUsage([{}]);
    const send = jest.spyOn(fakeR2, 'send');
    mockedGetUserFromAuth.mockResolvedValue({ user: plainAdmin, authFailedResponse: null });

    const response = await GET(createRequest());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'API request log export access required' });
    expect(send).not.toHaveBeenCalled();
    expect(mockedRecordAdminAction).not.toHaveBeenCalled();
  });

  it('applies a permission change to a session that is already signed in', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: { ...plainAdmin, can_export_api_request_logs: true },
      authFailedResponse: null,
    });

    expect((await GET(createRequest())).status).toBe(403);

    await db
      .update(kilocode_users)
      .set({ can_export_api_request_logs: true })
      .where(eq(kilocode_users.id, plainAdmin.id));

    expect((await GET(createRequest({ userId: '' }))).status).toBe(404);
    expect(mockedRecordAdminAction).not.toHaveBeenCalled();
  });

  it('reports a missing metadata bucket configuration before auditing', async () => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      R2_AI_PROVIDER_METADATA_BUCKET_NAME: '',
    });
    jest.spyOn(console, 'debug').mockImplementation(() => {});
    await insertUsage([{}]);

    const response = await GET(createRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'The AI provider metadata bucket is not configured',
    });
    expect(mockedRecordAdminAction).not.toHaveBeenCalled();
  });

  it.each([
    [{ id: '123' }, 'Invalid usage ID. Use a UUID.'],
    [{ organizationId: 'not-a-uuid' }, 'Invalid organization ID. Use a UUID.'],
    [
      { startDate: '2026/08/01' },
      'Invalid date or time. Use YYYY-MM-DD for dates and HH:MM (UTC) for times; a time requires a date.',
    ],
    [{ startTime: '11:00', endTime: '10:00' }, 'Start must be before end.'],
  ])('rejects invalid parameters %j', async (overrides, error) => {
    const response = await GET(createRequest(overrides));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(mockedRecordAdminAction).not.toHaveBeenCalled();
  });

  it('returns 404 without auditing when no usage matches', async () => {
    await insertUsage([{ created_at: '2026-08-02T12:00:00.000Z' }]);

    const response = await GET(createRequest());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'No records found for the given criteria' });
    expect(mockedRecordAdminAction).not.toHaveBeenCalled();
  });

  it('exports pretty-printed metadata, notes missing objects and load errors, and audits the export', async () => {
    const [found, missing, failing] = await insertUsage([
      { created_at: '2026-08-01T10:00:00.000Z' },
      { created_at: '2026-08-01T11:00:00.000Z' },
      { created_at: '2026-08-01T12:00:00.000Z' },
    ]);
    fakeR2.objects.delete(`${BUCKET}/${missing.id}.json`);
    const send = fakeR2.send.bind(fakeR2);
    jest.spyOn(fakeR2, 'send').mockImplementation(async command => {
      if (command instanceof GetObjectCommand && command.input.Key === `${failing.id}.json`) {
        throw new Error('R2 unavailable');
      }
      return send(command);
    });

    const response = await GET(createRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/zip');
    expect(response.headers.get('Content-Disposition')).toBe(
      `attachment; filename="provider-metadata_${TEST_USER_ID}_2026-08-01_2026-08-01.zip"`
    );
    expect(mockedRecordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        user: admin,
        trpcPath: '/admin/api/provider-metadata/download',
      }),
      {
        action: 'provider_metadata.download',
        target: { type: 'user', id: TEST_USER_ID },
        message: 'Started provider metadata ZIP export',
        metadata: {
          usageId: null,
          userId: TEST_USER_ID,
          organizationId: null,
          startAt: '2026-08-01T00:00:00.000Z',
          endAt: '2026-08-01T23:59:59.999Z',
          hasUserFilter: true,
          hasOrganizationFilter: false,
          hasModelPrefixFilter: false,
          hasSessionFilter: false,
        },
      }
    );

    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const prefix = (row: { id: string; created_at: string }) =>
      `${row.created_at.replaceAll(':', '-').replaceAll(' ', '_')}_${row.id}`;
    expect(Object.keys(entries).sort()).toEqual(
      [
        `${prefix(found)}.json`,
        `${prefix(failing)}_load-error.txt`,
        'MISSING_METADATA_README.txt',
      ].sort()
    );
    expect(strFromU8(entries[`${prefix(found)}.json`])).toBe(
      JSON.stringify({ usage_id: found.id }, null, 2)
    );
    expect(strFromU8(entries[`${prefix(failing)}_load-error.txt`])).toBe(
      `Failed to load ${failing.id}.json from R2: Error: R2 unavailable`
    );
    expect(strFromU8(entries['MISSING_METADATA_README.txt'])).toBe(
      '1 of the 3 exported usage records have no provider metadata object in R2.\n'
    );
  });

  it('filters by usage ID, organization, model prefix, and UTC time range', async () => {
    const organizationId = randomUUID();
    const [inOrg, otherOrg, otherModel, requestedModel, early] = await insertUsage([
      { organization_id: organizationId },
      { organization_id: randomUUID() },
      { organization_id: organizationId, model: 'openai/gpt-5' },
      {
        organization_id: organizationId,
        requested_model: 'anthropic/claude-opus-4.1',
        model: 'openai/gpt-5',
      },
      { organization_id: organizationId, created_at: '2026-08-01T09:59:59.999Z' },
    ]);

    expect(exportedIds(await download({ organizationId, model: 'anthropic/' })).sort()).toEqual(
      [inOrg.id, requestedModel.id, early.id].sort()
    );
    expect(exportedIds(await download({ model: 'openai/' })).sort()).toEqual([otherModel.id]);
    expect(exportedIds(await download({ startTime: '10:00' })).sort()).toEqual(
      [inOrg.id, otherOrg.id, otherModel.id, requestedModel.id].sort()
    );
    expect(exportedIds(await download({ id: otherOrg.id, userId: '', startDate: '' }))).toEqual([
      otherOrg.id,
    ]);
    expect((await GET(createRequest({ model: 'anthropic%' }))).status).toBe(404);
  });

  it('filters by session ID through microdollar_usage_metadata', async () => {
    const [inSession, otherSession] = await insertUsage([{}, {}]);
    await db.insert(microdollar_usage_metadata).values([
      { id: inSession.id, message_id: 'message-1', session_id: 'session-1' },
      { id: otherSession.id, message_id: 'message-2', session_id: 'session-2' },
    ]);

    const response = await GET(createRequest({ sessionId: 'session-1' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toContain('_session-1.zip');
    expect(exportedIds(unzipSync(new Uint8Array(await response.arrayBuffer())))).toEqual([
      inSession.id,
    ]);
  });

  it('exports every row once across batches that share a creation time', async () => {
    const rows = await insertUsage(Array.from({ length: ROUTE_BATCH_SIZE * 2 + 1 }, () => ({})));

    const ids = exportedIds(await download());

    expect(ids).toHaveLength(rows.length);
    expect(ids).toEqual(rows.map(row => row.id).sort());
  });

  it('stops at the time budget and explains that the ZIP is incomplete', async () => {
    const rows = await insertUsage(
      Array.from({ length: ROUTE_BATCH_SIZE + 5 }, (_, index) => ({
        created_at: new Date(Date.UTC(2026, 7, 1, 12, 0, index)).toISOString(),
      }))
    );
    const realNow = Date.now.bind(Date);
    let offsetMs = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offsetMs);
    const send = fakeR2.send.bind(fakeR2);
    jest.spyOn(fakeR2, 'send').mockImplementation(async command => {
      if (command instanceof GetObjectCommand && command.input.Key === `${rows[0].id}.json`) {
        offsetMs = 800_000;
      }
      return send(command);
    });

    const entries = await download();

    expect(exportedIds(entries)).toHaveLength(ROUTE_BATCH_SIZE);
    const notice = strFromU8(entries['INCOMPLETE_EXPORT_README.txt']);
    expect(notice).toContain(
      `It contains ${ROUTE_BATCH_SIZE} matching records. More matching records were not exported.`
    );
    expect(notice).toContain(
      `Records are exported in creation time order. The last exported record has id ${rows[ROUTE_BATCH_SIZE - 1].id}`
    );
  });
});
