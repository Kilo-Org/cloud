import { runScheduledBackfills, type ScheduledBackfillOutcome } from '@/lib/backfills/scheduled';
import { GET, maxDuration } from './route';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));
jest.mock('@/lib/backfills/scheduled', () => ({ runScheduledBackfills: jest.fn() }));

function request(authorization?: string) {
  return new Request('http://localhost/api/cron/backfill-users', {
    headers: authorization === undefined ? {} : { authorization },
  });
}

function loggedEvent(log: jest.SpyInstance): unknown {
  expect(log).toHaveBeenCalledTimes(1);
  return JSON.parse(String(log.mock.calls[0][0]));
}

const completedOutcomes: ScheduledBackfillOutcome[] = [
  { name: 'normalized_email', status: 'completed', processed: 3, remaining: false },
  { name: 'safety_identifiers', status: 'completed', processed: 50_000, remaining: true },
];

let info: jest.SpyInstance;
let error: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  info = jest.spyOn(console, 'info').mockImplementation(() => {});
  error = jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.mocked(runScheduledBackfills).mockResolvedValue(completedOutcomes);
});

afterEach(() => jest.restoreAllMocks());

test.each([undefined, 'Bearer wrong', 'cron-secret', 'Bearer cron-secret-extra'])(
  'rejects unauthorized cron requests: %p',
  async authorization => {
    expect((await GET(request(authorization))).status).toBe(401);
    expect(runScheduledBackfills).not.toHaveBeenCalled();
  }
);

test('fails closed when the cron secret is not configured', async () => {
  const config = jest.requireMock<{ CRON_SECRET: string }>(
    '@kilocode/web-shared/lib/config.server'
  );
  config.CRON_SECRET = '';
  try {
    expect((await GET(request('Bearer '))).status).toBe(401);
    expect(runScheduledBackfills).not.toHaveBeenCalled();
  } finally {
    config.CRON_SECRET = 'cron-secret';
  }
});

test('emits a success event with per-backfill metadata', async () => {
  const response = await GET(request('Bearer cron-secret'));

  expect(maxDuration).toBe(300);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ backfills: completedOutcomes });
  expect(loggedEvent(info)).toMatchObject({
    event_name: 'scheduled_job.completed',
    job_name: 'web.backfill_users',
    outcome: 'succeeded',
    normalized_email_processed_count: 3,
    normalized_email_remaining: false,
    safety_identifiers_processed_count: 50_000,
    safety_identifiers_remaining: true,
    failed_count: 0,
  });
  expect(loggedEvent(info)).not.toHaveProperty('failed_backfills');
  expect(error).not.toHaveBeenCalled();
});

test('returns 500 and emits a failure event naming the failed backfills', async () => {
  const outcomes: ScheduledBackfillOutcome[] = [
    { name: 'normalized_email', status: 'completed', processed: 3, remaining: false },
    { name: 'blocked_at', status: 'failed' },
    { name: 'safety_identifiers', status: 'failed' },
  ];
  jest.mocked(runScheduledBackfills).mockResolvedValue(outcomes);

  const response = await GET(request('Bearer cron-secret'));

  expect(response.status).toBe(500);
  await expect(response.json()).resolves.toEqual({ backfills: outcomes });
  const event = loggedEvent(error);
  expect(event).toMatchObject({
    job_name: 'web.backfill_users',
    outcome: 'failed',
    normalized_email_processed_count: 3,
    normalized_email_remaining: false,
    failed_count: 2,
    failed_backfills: 'blocked_at,safety_identifiers',
  });
  expect(event).not.toHaveProperty('blocked_at_processed_count');
  expect(info).not.toHaveBeenCalled();
});
