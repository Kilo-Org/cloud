import { db, sql } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { cloud_agent_code_reviews, kilocode_users, type User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { evaluateErrorSpike, evaluateSlowReviews } from './detectors';

const REPO = `test-org/code-review-alerts-${Date.now()}`;
type CodeReviewInsert = typeof cloud_agent_code_reviews.$inferInsert;

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

describe('code review alert detectors', () => {
  let testUser: User;
  let reviewSequence = 0;

  beforeAll(async () => {
    testUser = await insertTestUser();
  });

  beforeEach(async () => {
    await db.delete(cloud_agent_code_reviews).where(sql`true`);
  });

  afterEach(async () => {
    await db.delete(cloud_agent_code_reviews).where(sql`true`);
  });

  afterAll(async () => {
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  function reviewValues(overrides: Partial<CodeReviewInsert> = {}) {
    const sequence = reviewSequence++;
    const startedAt = minutesAgo(10);
    const completedAt = minutesAgo(5);

    return {
      owned_by_user_id: testUser.id,
      owned_by_organization_id: null,
      repo_full_name: REPO,
      pr_number: sequence + 1,
      pr_url: `https://github.com/${REPO}/pull/${sequence + 1}`,
      pr_title: `Test PR ${sequence + 1}`,
      pr_author: 'octocat',
      base_ref: 'main',
      head_ref: `feature/test-${sequence}`,
      head_sha: `sha-${sequence}`,
      status: 'completed',
      agent_version: 'v2',
      created_at: startedAt,
      updated_at: completedAt,
      started_at: startedAt,
      completed_at: completedAt,
      ...overrides,
    } satisfies CodeReviewInsert;
  }

  async function insertReviews(reviews: CodeReviewInsert[]): Promise<void> {
    await db.insert(cloud_agent_code_reviews).values(reviews);
  }

  it('trips slow-review alerts at 10% of recently started reviews', async () => {
    await insertReviews([
      reviewValues({
        started_at: minutesAgo(71),
        created_at: minutesAgo(71),
        completed_at: minutesAgo(10),
      }),
      ...Array.from({ length: 9 }, () => reviewValues()),
    ]);

    await expect(evaluateSlowReviews(db)).resolves.toMatchObject({
      tripped: true,
      details: {
        kind: 'slow_reviews',
        rate: 0.1,
        startedCount: 10,
        slowCount: 1,
        windowMinutes: 120,
        durationMinutes: 60,
      },
    });
  });

  it('does not trip slow-review alerts when no recent reviews are slow', async () => {
    await insertReviews(Array.from({ length: 10 }, () => reviewValues()));

    await expect(evaluateSlowReviews(db)).resolves.toEqual({ tripped: false });
  });

  it('excludes reviews started outside the slow-review window', async () => {
    await insertReviews([
      reviewValues({
        started_at: minutesAgo(121),
        created_at: minutesAgo(121),
        updated_at: minutesAgo(5),
        completed_at: null,
        status: 'running',
      }),
      ...Array.from({ length: 9 }, () => reviewValues()),
    ]);

    await expect(evaluateSlowReviews(db)).resolves.toEqual({ tripped: false });
  });

  it.each(['running', 'completed'] as const)(
    'uses updated_at for %s slow-review timing when started_at is missing',
    async status => {
      await insertReviews([
        reviewValues({
          status,
          started_at: null,
          created_at: minutesAgo(72 * 60),
          updated_at: minutesAgo(61),
          completed_at: status === 'running' ? null : minutesAgo(0),
        }),
        ...Array.from({ length: 9 }, () => reviewValues()),
      ]);

      await expect(evaluateSlowReviews(db)).resolves.toMatchObject({
        tripped: true,
        details: { kind: 'slow_reviews', rate: 0.1, startedCount: 10, slowCount: 1 },
      });
    }
  );

  it('excludes slow-review samples with an updated_at fallback outside the window', async () => {
    await insertReviews([
      reviewValues({
        status: 'running',
        started_at: null,
        created_at: minutesAgo(72 * 60),
        updated_at: minutesAgo(121),
        completed_at: null,
      }),
      ...Array.from({ length: 9 }, () => reviewValues()),
    ]);

    await expect(evaluateSlowReviews(db)).resolves.toEqual({ tripped: false });
  });

  it('counts running reviews over 60 minutes as slow', async () => {
    await insertReviews([
      reviewValues({
        status: 'running',
        created_at: minutesAgo(61),
        started_at: minutesAgo(61),
        updated_at: minutesAgo(5),
        completed_at: null,
      }),
      ...Array.from({ length: 9 }, () => reviewValues()),
    ]);

    await expect(evaluateSlowReviews(db)).resolves.toMatchObject({
      tripped: true,
      details: { kind: 'slow_reviews', startedCount: 10, slowCount: 1 },
    });
  });

  it('counts terminal reviews over 60 minutes as slow', async () => {
    await insertReviews([
      reviewValues({
        started_at: minutesAgo(70),
        created_at: minutesAgo(70),
        completed_at: minutesAgo(9),
      }),
      ...Array.from({ length: 9 }, () => reviewValues()),
    ]);

    await expect(evaluateSlowReviews(db)).resolves.toMatchObject({
      tripped: true,
      details: { kind: 'slow_reviews', startedCount: 10, slowCount: 1 },
    });
  });

  it('uses updated_at for completed-review duration when completed_at is missing', async () => {
    await insertReviews([
      reviewValues({
        started_at: minutesAgo(70),
        created_at: minutesAgo(70),
        completed_at: null,
        updated_at: minutesAgo(9),
      }),
      ...Array.from({ length: 9 }, () => reviewValues()),
    ]);

    await expect(evaluateSlowReviews(db)).resolves.toMatchObject({
      tripped: true,
      details: { kind: 'slow_reviews', rate: 0.1, startedCount: 10, slowCount: 1 },
    });
  });

  it('does not count terminal reviews completed before 60 minutes as slow', async () => {
    await insertReviews([
      reviewValues({
        started_at: minutesAgo(64),
        created_at: minutesAgo(64),
        completed_at: minutesAgo(5),
      }),
      ...Array.from({ length: 9 }, () => reviewValues()),
    ]);

    await expect(evaluateSlowReviews(db)).resolves.toEqual({ tripped: false });
  });

  it('excludes pending and queued reviews from slow-review denominators', async () => {
    await insertReviews([
      reviewValues({
        status: 'queued',
        created_at: minutesAgo(90),
        updated_at: minutesAgo(90),
        started_at: null,
        completed_at: null,
      }),
      reviewValues({
        status: 'pending',
        created_at: minutesAgo(90),
        updated_at: minutesAgo(90),
        started_at: null,
        completed_at: null,
      }),
    ]);

    await expect(evaluateSlowReviews(db)).resolves.toEqual({ tripped: false });
  });

  it('trips error-spike alerts at 20% of recently started reviews', async () => {
    await insertReviews([
      reviewValues({ status: 'failed', terminal_reason: 'timeout' }),
      reviewValues({ status: 'failed', terminal_reason: 'timeout' }),
      reviewValues({ status: 'failed', terminal_reason: 'timeout' }),
      reviewValues({ status: 'failed', terminal_reason: 'timeout' }),
      ...Array.from({ length: 16 }, () => reviewValues()),
    ]);

    await expect(evaluateErrorSpike(db)).resolves.toMatchObject({
      tripped: true,
      details: {
        kind: 'error_spike',
        rate: 0.2,
        startedCount: 20,
        errorCount: 4,
        windowMinutes: 30,
        topReason: 'timeout',
        topReasonCount: 4,
      },
    });
  });

  it('excludes abandoned reviews from the error-spike denominator', async () => {
    await insertReviews([
      reviewValues({ status: 'failed', terminal_reason: 'timeout' }),
      ...Array.from({ length: 4 }, () => reviewValues()),
      ...Array.from({ length: 5 }, () =>
        reviewValues({
          status: 'failed',
          terminal_reason: 'abandoned',
          started_at: null,
          created_at: minutesAgo(72 * 60),
          updated_at: minutesAgo(0),
          completed_at: minutesAgo(0),
        })
      ),
    ]);

    await expect(evaluateErrorSpike(db)).resolves.toMatchObject({
      tripped: true,
      details: { rate: 0.2, startedCount: 5, errorCount: 1 },
    });
  });

  it('does not trip error-spike alerts with no recent errors', async () => {
    await insertReviews(Array.from({ length: 20 }, () => reviewValues()));

    await expect(evaluateErrorSpike(db)).resolves.toEqual({ tripped: false });
  });

  it('does not trip error-spike alerts below 20%', async () => {
    await insertReviews([
      reviewValues({ status: 'failed', terminal_reason: 'timeout' }),
      ...Array.from({ length: 20 }, () => reviewValues()),
    ]);

    await expect(evaluateErrorSpike(db)).resolves.toEqual({ tripped: false });
  });

  it('excludes errors from reviews started outside the error-spike window', async () => {
    await insertReviews([
      reviewValues({
        status: 'failed',
        terminal_reason: 'timeout',
        created_at: minutesAgo(31),
        updated_at: minutesAgo(5),
        started_at: minutesAgo(31),
        completed_at: minutesAgo(5),
      }),
      ...Array.from({ length: 19 }, () => reviewValues()),
    ]);

    await expect(evaluateErrorSpike(db)).resolves.toEqual({ tripped: false });
  });

  it('uses updated_at for error-spike timing when started_at is missing', async () => {
    await insertReviews([
      reviewValues({
        status: 'failed',
        terminal_reason: 'timeout',
        started_at: null,
        created_at: minutesAgo(72 * 60),
        updated_at: minutesAgo(10),
      }),
      ...Array.from({ length: 4 }, () => reviewValues()),
    ]);

    await expect(evaluateErrorSpike(db)).resolves.toMatchObject({
      tripped: true,
      details: {
        kind: 'error_spike',
        rate: 0.2,
        startedCount: 5,
        errorCount: 1,
        topReason: 'timeout',
        topReasonCount: 1,
      },
    });
  });

  it('excludes error-spike samples with an updated_at fallback outside the window', async () => {
    await insertReviews([
      reviewValues({
        status: 'failed',
        terminal_reason: 'timeout',
        started_at: null,
        created_at: minutesAgo(72 * 60),
        updated_at: minutesAgo(31),
      }),
      ...Array.from({ length: 4 }, () => reviewValues()),
    ]);

    await expect(evaluateErrorSpike(db)).resolves.toEqual({ tripped: false });
  });

  it('excludes benign terminal reasons from error-spike counts', async () => {
    await insertReviews([
      reviewValues({ status: 'failed', terminal_reason: 'billing' }),
      reviewValues({ status: 'cancelled', terminal_reason: 'model_not_found' }),
      reviewValues({ status: 'cancelled', terminal_reason: 'user_cancelled' }),
      reviewValues({ status: 'cancelled', terminal_reason: 'superseded' }),
      reviewValues({ status: 'failed', terminal_reason: 'github_installation_required' }),
      reviewValues({ status: 'failed', terminal_reason: 'github_ip_allow_list' }),
      reviewValues({ status: 'failed', terminal_reason: 'byok_invalid_key' }),
      reviewValues({ status: 'failed', terminal_reason: 'selected_model_unavailable' }),
      ...Array.from({ length: 13 }, () => reviewValues()),
    ]);

    await expect(evaluateErrorSpike(db)).resolves.toEqual({ tripped: false });
  });

  it('excludes selected model unavailable from error-spike counts', async () => {
    await insertReviews([
      reviewValues({ status: 'failed', terminal_reason: 'selected_model_unavailable' }),
      ...Array.from({ length: 3 }, () => reviewValues()),
    ]);

    await expect(evaluateErrorSpike(db)).resolves.toEqual({ tripped: false });
  });

  it.each([
    ['assistant_invalid_request_byok', false],
    ['assistant_invalid_request', true],
  ] as const)(
    'classifies invalid-request reason %s for error-spike alerts',
    async (terminalReason, tripped) => {
      await insertReviews([
        reviewValues({ status: 'failed', terminal_reason: terminalReason }),
        ...Array.from({ length: 3 }, () => reviewValues()),
      ]);

      await expect(evaluateErrorSpike(db)).resolves.toMatchObject({ tripped });
    }
  );

  it('excludes model-not-found error messages from error-spike counts', async () => {
    await insertReviews([
      reviewValues({
        status: 'failed',
        terminal_reason: null,
        error_message: 'Model not found: x',
      }),
      reviewValues({
        status: 'failed',
        terminal_reason: null,
        error_message: 'model not found: y',
      }),
      reviewValues({ status: 'cancelled', terminal_reason: 'model_not_found' }),
      reviewValues({
        status: 'failed',
        terminal_reason: null,
        error_message: 'Model not found: z',
      }),
      ...Array.from({ length: 16 }, () => reviewValues()),
    ]);

    await expect(evaluateErrorSpike(db)).resolves.toEqual({ tripped: false });
  });

  it('counts non-model not-found failures as errors', async () => {
    await insertReviews([
      reviewValues({
        status: 'failed',
        terminal_reason: null,
        error_message: 'Repository not found',
      }),
      reviewValues({ status: 'failed', terminal_reason: null, error_message: 'Session not found' }),
      reviewValues({ status: 'failed', terminal_reason: null, error_message: 'Checkout failed' }),
      reviewValues({
        status: 'failed',
        terminal_reason: null,
        error_message: 'GitHub unavailable',
      }),
      ...Array.from({ length: 16 }, () => reviewValues()),
    ]);

    await expect(evaluateErrorSpike(db)).resolves.toMatchObject({
      tripped: true,
      details: {
        kind: 'error_spike',
        startedCount: 20,
        errorCount: 4,
        rate: 0.2,
        topReason: 'unknown',
        topReasonCount: 4,
      },
    });
  });

  it('counts interrupted and cancelled interrupted reviews as error spikes', async () => {
    await insertReviews([
      reviewValues({ status: 'interrupted', terminal_reason: 'interrupted' }),
      reviewValues({ status: 'cancelled', terminal_reason: 'interrupted' }),
      reviewValues({ status: 'interrupted', terminal_reason: 'interrupted' }),
      reviewValues({ status: 'cancelled', terminal_reason: 'interrupted' }),
      reviewValues({ status: 'interrupted', terminal_reason: 'interrupted' }),
      reviewValues({ status: 'cancelled', terminal_reason: 'interrupted' }),
      reviewValues({ status: 'interrupted', terminal_reason: 'interrupted' }),
      reviewValues({ status: 'cancelled', terminal_reason: 'interrupted' }),
      ...Array.from({ length: 32 }, () => reviewValues()),
    ]);

    await expect(evaluateErrorSpike(db)).resolves.toMatchObject({
      tripped: true,
      details: { kind: 'error_spike', startedCount: 40, errorCount: 8, topReason: 'interrupted' },
    });
  });

  it('counts failed reviews with missing terminal reasons as unknown errors', async () => {
    await insertReviews([
      reviewValues({ status: 'failed', terminal_reason: null }),
      reviewValues({ status: 'failed', terminal_reason: null }),
      reviewValues({ status: 'failed', terminal_reason: null }),
      reviewValues({ status: 'failed', terminal_reason: null }),
      ...Array.from({ length: 16 }, () => reviewValues()),
    ]);

    await expect(evaluateErrorSpike(db)).resolves.toMatchObject({
      tripped: true,
      details: {
        kind: 'error_spike',
        startedCount: 20,
        errorCount: 4,
        rate: 0.2,
        topReason: 'unknown',
        topReasonCount: 4,
      },
    });
  });

  it('excludes pending and queued reviews from error-spike denominators', async () => {
    await insertReviews([
      reviewValues({
        status: 'queued',
        created_at: minutesAgo(5),
        updated_at: minutesAgo(5),
        started_at: null,
        completed_at: null,
      }),
      reviewValues({
        status: 'pending',
        created_at: minutesAgo(5),
        updated_at: minutesAgo(5),
        started_at: null,
        completed_at: null,
      }),
    ]);

    await expect(evaluateErrorSpike(db)).resolves.toEqual({ tripped: false });
  });
});
