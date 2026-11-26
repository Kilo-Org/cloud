import {
  backfillCredentialKmsEnvelopes,
  type CredentialKmsBackfillStoreSummary,
} from '@/lib/credential-kms-backfill';
import { GET, maxDuration } from './route';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));
jest.mock('@/lib/credential-kms-backfill', () => ({ backfillCredentialKmsEnvelopes: jest.fn() }));

function request(authorization?: string) {
  return new Request('http://localhost/api/cron/backfill-credential-kms-envelopes', {
    headers: authorization === undefined ? {} : { authorization },
  });
}

function loggedEvent(log: jest.SpyInstance): Record<string, unknown> {
  expect(log).toHaveBeenCalledTimes(1);
  return JSON.parse(String(log.mock.calls[0][0])) as Record<string, unknown>;
}

function summary(
  store: CredentialKmsBackfillStoreSummary['store'],
  overrides: Partial<CredentialKmsBackfillStoreSummary> = {}
): CredentialKmsBackfillStoreSummary {
  return {
    store,
    scanned: 0,
    migrated: 0,
    skippedConcurrentWrite: 0,
    clearedOrphanedEnvelopes: 0,
    failed: { legacy_unreadable: 0, kms: 0, database: 0 },
    remaining: 0,
    reachedEnd: true,
    errorName: null,
    ...overrides,
  };
}

let info: jest.SpyInstance;
let error: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  info = jest.spyOn(console, 'info').mockImplementation(() => {});
  error = jest.spyOn(console, 'error').mockImplementation(() => {});
  jest
    .mocked(backfillCredentialKmsEnvelopes)
    .mockResolvedValue([summary('coding_plan_inventory'), summary('openai_chatgpt_connections')]);
});

afterEach(() => jest.restoreAllMocks());

test.each([undefined, 'Bearer wrong', 'cron-secret', 'Bearer cron-secret-extra'])(
  'rejects unauthorized cron requests without logging: %p',
  async authorization => {
    expect((await GET(request(authorization))).status).toBe(401);
    expect(backfillCredentialKmsEnvelopes).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  }
);

test('fails closed when the cron secret is not configured', async () => {
  const config = jest.requireMock<{ CRON_SECRET: string }>(
    '@kilocode/web-shared/lib/config.server'
  );
  config.CRON_SECRET = '';
  try {
    expect((await GET(request('Bearer '))).status).toBe(401);
    expect(backfillCredentialKmsEnvelopes).not.toHaveBeenCalled();
  } finally {
    config.CRON_SECRET = 'cron-secret';
  }
});

test('logs explicit completion on a run with no work', async () => {
  const before = Date.now();
  const response = await GET(request('Bearer cron-secret'));

  expect(maxDuration).toBe(300);
  const { deadlineAt } = jest.mocked(backfillCredentialKmsEnvelopes).mock.calls[0][0];
  expect(deadlineAt - before).toBeLessThanOrEqual(maxDuration * 1000 - 60_000);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ completed: true });
  expect(loggedEvent(info)).toMatchObject({
    event_name: 'scheduled_job.completed',
    job_name: 'web.backfill_credential_kms_envelopes',
    outcome: 'succeeded',
    backfill_completed: true,
    coding_plan_inventory_remaining_known: true,
    coding_plan_inventory_remaining_count: 0,
    coding_plan_inventory_completed: true,
    coding_plan_inventory_migrated_count: 0,
    openai_chatgpt_connections_remaining_known: true,
    openai_chatgpt_connections_remaining_count: 0,
    openai_chatgpt_connections_completed: true,
  });
  expect(error).not.toHaveBeenCalled();
});

test('logs progress with each store remaining count while work is left', async () => {
  jest.mocked(backfillCredentialKmsEnvelopes).mockResolvedValue([
    summary('coding_plan_inventory', {
      scanned: 40,
      migrated: 39,
      skippedConcurrentWrite: 1,
      clearedOrphanedEnvelopes: 2,
      remaining: 1,
    }),
    summary('openai_chatgpt_connections', { scanned: 100, migrated: 100, remaining: 250 }),
  ]);

  const response = await GET(request('Bearer cron-secret'));

  expect(response.status).toBe(200);
  const event = loggedEvent(info);
  expect(event).toMatchObject({
    outcome: 'succeeded',
    backfill_completed: false,
    coding_plan_inventory_scanned_count: 40,
    coding_plan_inventory_migrated_count: 39,
    coding_plan_inventory_skipped_concurrent_write_count: 1,
    coding_plan_inventory_cleared_orphaned_envelope_count: 2,
    coding_plan_inventory_failed_count: 0,
    coding_plan_inventory_remaining_count: 1,
    coding_plan_inventory_completed: false,
    openai_chatgpt_connections_migrated_count: 100,
    openai_chatgpt_connections_remaining_count: 250,
    openai_chatgpt_connections_completed: false,
  });
  expect(event).not.toHaveProperty('coding_plan_inventory_error');
});

test('reports row failures by category and marks the run failed', async () => {
  jest.mocked(backfillCredentialKmsEnvelopes).mockResolvedValue([
    summary('coding_plan_inventory', {
      failed: { legacy_unreadable: 1, kms: 2, database: 0 },
      remaining: 3,
    }),
    summary('openai_chatgpt_connections'),
  ]);

  const response = await GET(request('Bearer cron-secret'));

  expect(response.status).toBe(500);
  expect(info).not.toHaveBeenCalled();
  expect(loggedEvent(error)).toMatchObject({
    outcome: 'failed',
    backfill_completed: false,
    coding_plan_inventory_failed_count: 3,
    coding_plan_inventory_failed_legacy_unreadable_count: 1,
    coding_plan_inventory_failed_kms_count: 2,
    coding_plan_inventory_remaining_count: 3,
    openai_chatgpt_connections_completed: true,
  });
});

test('counts unreadable static-key copies without failing the run', async () => {
  jest.mocked(backfillCredentialKmsEnvelopes).mockResolvedValue([
    summary('coding_plan_inventory', {
      scanned: 2,
      failed: { legacy_unreadable: 2, kms: 0, database: 0 },
      remaining: 2,
    }),
    summary('openai_chatgpt_connections'),
  ]);

  const response = await GET(request('Bearer cron-secret'));

  expect(response.status).toBe(200);
  expect(error).not.toHaveBeenCalled();
  expect(loggedEvent(info)).toMatchObject({
    outcome: 'succeeded',
    backfill_completed: false,
    coding_plan_inventory_failed_legacy_unreadable_count: 2,
    coding_plan_inventory_remaining_count: 2,
    coding_plan_inventory_completed: false,
    coding_plan_inventory_only_unreadable_remaining: true,
    openai_chatgpt_connections_only_unreadable_remaining: false,
  });
});

test('reports an unknown remaining count as unknown, not zero', async () => {
  jest
    .mocked(backfillCredentialKmsEnvelopes)
    .mockResolvedValue([
      summary('coding_plan_inventory'),
      summary('openai_chatgpt_connections', { remaining: null, errorName: 'DrizzleQueryError' }),
    ]);

  const response = await GET(request('Bearer cron-secret'));

  expect(response.status).toBe(500);
  const event = loggedEvent(error);
  expect(event).toMatchObject({
    outcome: 'failed',
    backfill_completed: false,
    openai_chatgpt_connections_remaining_known: false,
    openai_chatgpt_connections_completed: false,
    openai_chatgpt_connections_error: 'DrizzleQueryError',
  });
  expect(event).not.toHaveProperty('openai_chatgpt_connections_remaining_count');
});

test('reports a thrown failure with every remaining count unknown and no error text', async () => {
  jest
    .mocked(backfillCredentialKmsEnvelopes)
    .mockRejectedValue(new Error('upstream rejected token sk-live-do-not-log'));

  const response = await GET(request('Bearer cron-secret'));

  expect(response.status).toBe(500);
  const logged = String(error.mock.calls[0][0]);
  expect(logged).not.toContain('sk-live-do-not-log');
  expect(loggedEvent(error)).toMatchObject({
    outcome: 'failed',
    exception_name: 'Error',
    backfill_completed: false,
    coding_plan_inventory_remaining_known: false,
    openai_chatgpt_connections_remaining_known: false,
  });
  await expect(response.json()).resolves.toEqual({ error: 'Credential KMS backfill failed' });
});
