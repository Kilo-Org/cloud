import { eq } from 'drizzle-orm';
import { blacklisted_domains, kilocode_users } from '@kilocode/db';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { generateVercelDownstreamSafetyIdentifier } from '@kilocode/web-shared/lib/ai-gateway/providerHash';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { runScheduledBackfills } from './scheduled';

const originalOrg = process.env.OPENROUTER_ORG_ID;
const blockedUpdatedAt = '2026-01-15T12:00:00.000Z';

const backfillOrder = [
  'normalized_email',
  'email_domain',
  'block_blacklisted_domains',
  'blocked_at',
  'blocked_user_pepper',
  'safety_identifiers',
];

async function selectUser(id: string) {
  const [row] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, id));
  return row;
}

async function insertScenario() {
  await db.insert(blacklisted_domains).values({ domain: 'mailinator.com' });
  return {
    regular: await insertTestUser({ google_user_email: 'Some.One+tag@Example.com' }),
    blacklisted: await insertTestUser({ google_user_email: 'spammer@mailinator.com' }),
    blocked: await insertTestUser({
      google_user_email: 'blocked@example.org',
      blocked_reason: 'abuse',
      updated_at: blockedUpdatedAt,
    }),
  };
}

beforeEach(async () => {
  await cleanupDbForTest();
  process.env.OPENROUTER_ORG_ID = 'synthetic-org';
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  if (originalOrg === undefined) delete process.env.OPENROUTER_ORG_ID;
  else process.env.OPENROUTER_ORG_ID = originalOrg;
});

describe('runScheduledBackfills', () => {
  it('runs one batch of every backfill in order and fills the data', async () => {
    const { regular, blacklisted, blocked } = await insertScenario();

    const outcomes = await runScheduledBackfills({ deadlineAt: Number.POSITIVE_INFINITY });

    expect(outcomes).toEqual([
      { name: 'normalized_email', status: 'completed', processed: 3, remaining: false },
      { name: 'email_domain', status: 'completed', processed: 3, remaining: false },
      { name: 'block_blacklisted_domains', status: 'completed', processed: 1, remaining: false },
      { name: 'blocked_at', status: 'completed', processed: 1, remaining: false },
      { name: 'blocked_user_pepper', status: 'completed', processed: 1, remaining: false },
      { name: 'safety_identifiers', status: 'completed', processed: 3, remaining: false },
    ]);

    expect(await selectUser(regular.id)).toMatchObject({
      normalized_email: 'some.one@example.com',
      email_domain: 'example.com',
      blocked_reason: null,
      vercel_downstream_safety_identifier: generateVercelDownstreamSafetyIdentifier(regular.id),
    });

    const blockedRow = await selectUser(blocked.id);
    expect(new Date(blockedRow.blocked_at ?? '').toISOString()).toBe(blockedUpdatedAt);
    expect(blockedRow.api_token_pepper).toEqual(expect.any(String));

    const blacklistedRow = await selectUser(blacklisted.id);
    expect(blacklistedRow).toMatchObject({
      email_domain: 'mailinator.com',
      blocked_reason: 'domainblocked',
      blocked_by_kilo_user_id: null,
    });
    expect(blacklistedRow.blocked_at).not.toBeNull();
    expect(blacklistedRow.api_token_pepper).toEqual(expect.any(String));
  });

  it('reports a failed backfill without stopping the ones after it', async () => {
    const { regular, blacklisted } = await insertScenario();
    const driverError = Object.assign(new Error('synthetic sensitive driver detail'), {
      code: '40001',
    });
    const queryError = new Error('synthetic sensitive query', { cause: driverError });
    queryError.name = 'DrizzleQueryError';
    jest.spyOn(db, 'execute').mockRejectedValueOnce(queryError);

    const outcomes = await runScheduledBackfills({ deadlineAt: Number.POSITIVE_INFINITY });

    expect(outcomes.map(outcome => outcome.name)).toEqual(backfillOrder);
    expect(outcomes[0]).toEqual({ name: 'normalized_email', status: 'failed' });
    expect(outcomes.slice(1).every(outcome => outcome.status === 'completed')).toBe(true);
    expect(console.error).toHaveBeenCalledWith('Scheduled backfill failed', {
      backfill: 'normalized_email',
      exception_name: 'DrizzleQueryError',
      database_error_code: '40001',
    });
    expect(JSON.stringify(jest.mocked(console.error).mock.calls)).not.toContain(
      'synthetic sensitive'
    );

    expect(await selectUser(regular.id)).toMatchObject({
      normalized_email: null,
      email_domain: 'example.com',
      vercel_downstream_safety_identifier: generateVercelDownstreamSafetyIdentifier(regular.id),
    });
    expect(await selectUser(blacklisted.id)).toMatchObject({
      blocked_reason: 'domainblocked',
      blocked_by_kilo_user_id: null,
    });
  });

  it('skips backfills that have not started by the deadline', async () => {
    const { regular } = await insertScenario();

    const outcomes = await runScheduledBackfills({ deadlineAt: Date.now() - 1 });

    expect(outcomes).toEqual(backfillOrder.map(name => ({ name, status: 'skipped' })));
    expect(await selectUser(regular.id)).toMatchObject({
      normalized_email: null,
      email_domain: null,
      vercel_downstream_safety_identifier: null,
    });
  });

  it('reports safety identifiers as failed when OPENROUTER_ORG_ID is unset', async () => {
    const { regular } = await insertScenario();
    delete process.env.OPENROUTER_ORG_ID;

    const outcomes = await runScheduledBackfills({ deadlineAt: Number.POSITIVE_INFINITY });

    expect(outcomes.map(outcome => outcome.name)).toEqual(backfillOrder);
    expect(outcomes.at(-1)).toEqual({ name: 'safety_identifiers', status: 'failed' });
    expect(outcomes.slice(0, -1).every(outcome => outcome.status === 'completed')).toBe(true);
    expect(console.error).toHaveBeenCalledWith('Scheduled backfill failed', {
      backfill: 'safety_identifiers',
      exception_name: 'Error',
      database_error_code: null,
    });
    expect(await selectUser(regular.id)).toMatchObject({
      normalized_email: 'some.one@example.com',
      vercel_downstream_safety_identifier: null,
    });
  });
});
