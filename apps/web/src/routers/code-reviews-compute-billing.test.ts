import { captureException } from '@sentry/nextjs';
import type * as Sentry from '@sentry/nextjs';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createCallerFactory } from '@kilocode/web-shared/lib/trpc/init';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import {
  cloud_agent_code_review_attempts,
  cloud_agent_code_reviews,
  cloud_billing_sku,
  compute_usage_charge,
  container_usage_interval,
  container_usage_segment,
  organization_memberships,
} from '@kilocode/db/schema';
import * as computeBilling from '@/lib/code-reviews/compute-billing';
import { codeReviewRouter } from './code-reviews/code-reviews-router';

jest.mock('@sentry/nextjs', () => ({
  ...jest.requireActual<typeof Sentry>('@sentry/nextjs'),
  captureException: jest.fn(),
}));
jest.mock('@/lib/code-reviews/compute-billing', () => {
  const actual = jest.requireActual<typeof computeBilling>('@/lib/code-reviews/compute-billing');
  return {
    ...actual,
    readCodeReviewContainerCost: jest.fn(actual.readCodeReviewContainerCost),
  };
});

const createCaller = createCallerFactory(codeReviewRouter);
type Payer = { type: 'user' | 'org'; id: string };

async function fixture(type: Payer['type'] = 'user') {
  const user = await insertTestUser();
  const member = await insertTestUser();
  const outsider = await insertTestUser();
  const org = await createTestOrganization('Review compute tests', user.id, 0);
  await db.insert(organization_memberships).values({
    organization_id: org.id,
    kilo_user_id: member.id,
    role: 'member',
  });
  const payer: Payer = type === 'org' ? { type, id: org.id } : { type, id: user.id };
  const sessionId = `workspace_${crypto.randomUUID()}`;
  const attemptSessionId = `workspace_${crypto.randomUUID()}`;
  const [review] = await db
    .insert(cloud_agent_code_reviews)
    .values({
      owned_by_user_id: type === 'user' ? user.id : null,
      owned_by_organization_id: type === 'org' ? org.id : null,
      repo_full_name: 'synthetic/review-compute',
      pr_number: 1,
      pr_url: 'https://github.com/synthetic/review-compute/pull/1',
      pr_title: 'Synthetic review',
      pr_author: 'synthetic-author',
      base_ref: 'main',
      head_ref: 'review-compute',
      head_sha: 'a'.repeat(40),
      status: 'completed',
      session_id: sessionId,
      created_at: '2026-10-01 00:00:00+00',
    })
    .returning();
  await db.insert(cloud_agent_code_review_attempts).values([
    {
      code_review_id: review.id,
      attempt_number: 1,
      status: 'failed',
      session_id: attemptSessionId,
    },
    {
      code_review_id: review.id,
      attempt_number: 2,
      status: 'completed',
      session_id: sessionId,
    },
  ]);
  const skuId = `review-compute-${crypto.randomUUID()}`;
  await db.insert(cloud_billing_sku).values({
    id: skuId,
    name: 'Synthetic review compute',
    unit: 'second',
    rate_cents_per_unit: '0.01',
  });
  return { user, member, outsider, org, payer, review, sessionId, attemptSessionId, skuId };
}

async function seedUsage(input: {
  payer: Payer;
  sessionId: string;
  skuId: string;
  seconds: number;
  createdAt?: string;
  billingMode?: 'paid' | 'shadow';
}) {
  const id = crypto.randomUUID();
  const date = input.createdAt ?? '2026-10-31T12:00:00.000Z';
  const billingMode = input.billingMode ?? 'paid';
  await db.insert(container_usage_interval).values({
    id,
    service: 'cloud-agent-next-sandbox-containers-code-review',
    instance_id: id,
    start_epoch_ms: Date.parse(date),
    cloud_billing_sku_id: input.skuId,
    context_fingerprint: 'a'.repeat(64),
    subject_type: input.payer.type,
    subject_id: input.payer.id,
    actor_type: 'user',
    actor_id: input.payer.id,
    session_id: input.sessionId,
    started_at: date,
    last_seen_at: date,
    billing_mode: billingMode,
    rate_cents_per_unit: billingMode === 'paid' ? '0.01' : null,
  });
  await db.insert(container_usage_segment).values({
    interval_id: id,
    seq: 1,
    idempotency_key: id,
    reported_seconds: input.seconds,
    usage_seconds: input.seconds,
    received_at: date,
  });
  if (billingMode === 'paid') {
    await db.insert(compute_usage_charge).values({
      usage_source: 'container_usage_segment',
      usage_source_id: id,
      cloud_billing_sku_id: input.skuId,
      user_id: input.payer.type === 'user' ? input.payer.id : null,
      organization_id: input.payer.type === 'org' ? input.payer.id : null,
      quantity: String(input.seconds),
      rate_cents_per_unit: '0.01',
      amount_microdollars: input.seconds * 100,
      created_at: date,
    });
  }
}

afterEach(() => jest.clearAllMocks());

describe('codeReviewRouter.get compute costs', () => {
  it.each(['user', 'org'] as const)(
    'returns all attempt charges once for the %s payer and excludes foreign payers',
    async type => {
      const data = await fixture(type);
      await seedUsage({ ...data, seconds: 120 });
      await seedUsage({
        ...data,
        sessionId: data.attemptSessionId,
        seconds: 60,
        createdAt: '2026-11-01T12:00:00.000Z',
      });
      await seedUsage({ ...data, payer: { type: 'user', id: data.outsider.id }, seconds: 999 });
      await seedUsage({
        ...data,
        payer:
          type === 'user' ? { type: 'org', id: data.org.id } : { type: 'user', id: data.user.id },
        seconds: 999,
      });

      const callers = type === 'org' ? [data.user, data.member] : [data.user];
      for (const user of callers) {
        const result = await createCaller({ user }).get({ reviewId: data.review.id });
        expect(result).toMatchObject({ success: true, containerCostMusd: 18_000 });
        if (type === 'org' && user.id === data.member.id) {
          expect(result).toMatchObject({
            review: { session_id: null, rawIdsRedacted: true },
            attempts: [{ session_id: null }, { session_id: null }],
          });
        }
      }
      await expect(
        createCaller({ user: data.outsider }).get({ reviewId: data.review.id })
      ).rejects.toMatchObject({ code: type === 'org' ? 'UNAUTHORIZED' : 'FORBIDDEN' });
    }
  );

  it('returns no compute cost for shadow usage without charges', async () => {
    const data = await fixture();
    await seedUsage({ ...data, seconds: 120, billingMode: 'shadow' });
    await expect(
      createCaller({ user: data.user }).get({ reviewId: data.review.id })
    ).resolves.toMatchObject({
      success: true,
      containerCostMusd: null,
    });
  });

  it('keeps the review readable on a supplementary billing failure and recovers on the next read', async () => {
    const data = await fixture();
    await seedUsage({ ...data, seconds: 120 });
    const error = new Error('Synthetic billing read failure');
    jest.mocked(computeBilling.readCodeReviewContainerCost).mockRejectedValueOnce(error);
    const caller = createCaller({ user: data.user });
    await expect(caller.get({ reviewId: data.review.id })).resolves.toMatchObject({
      success: true,
      review: { id: data.review.id },
      containerCostMusd: null,
    });
    expect(captureException).toHaveBeenCalledWith(error, {
      tags: { operation: 'readCodeReviewContainerCost' },
      extra: { reviewId: data.review.id },
    });
    await expect(caller.get({ reviewId: data.review.id })).resolves.toMatchObject({
      success: true,
      containerCostMusd: 12_000,
    });
  });
});
