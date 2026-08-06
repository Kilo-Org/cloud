import { timingSafeEqual } from '@kilocode/encryption';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { saveUsageRelatedDataLocally } from '@/lib/ai-gateway/processUsage';
import {
  UsageRecordRequestSchema,
  type UsageRecordResponse,
} from '@/lib/ai-gateway/usage-record-contract';
import {
  createPhaseTimer,
  emitUsageRecordTiming,
  readPoolGauges,
  shouldEmitUsageRecordTiming,
} from '@/lib/ai-gateway/usage-record-diagnostics';

/**
 * Frankfurt-local sink for AI-gateway usage writes.
 *
 * Callers are SFO instances of `kilocode-global-app`, which are a transatlantic
 * round trip away from the PostgreSQL primary. Executing the write here collapses
 * the row-lock hold on `kilocode_users` / `organizations` /
 * `organization_user_usage` from hundreds of milliseconds to single-digit
 * milliseconds. See `usage-record-client.ts` for the calling side.
 *
 * This route only does the right thing on a deployment whose functions run in
 * Frankfurt. `APP_URL` points at `kilocode-app`, which is Frankfurt-only, and
 * whose rewrites do not divert `/api/internal/*`.
 */

// The usage transaction can legitimately block on a contended counter row up to
// the database `statement_timeout` ceiling of 120s. Allow more than that so a
// slow write is reported rather than silently truncated into a lost billing row.
export const maxDuration = 150;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = request.headers.get('x-internal-api-key');
  if (!INTERNAL_API_SECRET || !secret || !timingSafeEqual(secret, INTERNAL_API_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Phase timings, paired with the in-process pool gauges, are what identified that
  // pool acquisition rather than PostgreSQL or the event loop dominates this
  // endpoint's latency. Keep them: the same signal is how the effect of removing
  // the pre-check gets confirmed.
  const timer = createPhaseTimer();
  const poolBefore = readPoolGauges();
  let poolWaitingPeak = poolBefore.waiting;
  const samplePool = () => {
    const gauges = readPoolGauges();
    poolWaitingPeak = Math.max(poolWaitingPeak, gauges.waiting);
    return gauges;
  };
  const reportTiming = (usageId: string, outcome: UsageRecordResponse['status']) => {
    const totalMs = timer.totalMs();
    if (!shouldEmitUsageRecordTiming(totalMs)) return;
    emitUsageRecordTiming({
      usageId,
      outcome,
      totalMs,
      phases: timer.phases(),
      poolBefore,
      poolAfter: samplePool(),
      poolWaitingPeak,
    });
  };

  const rawBody: unknown = await request.json().catch(() => null);
  const parsed = UsageRecordRequestSchema.safeParse(rawBody);
  timer.mark('validate');
  if (!parsed.success) {
    // Deliberately a 400: the client must not retry a payload we cannot accept,
    // and a schema failure here means a lost billing row that needs a human.
    console.error('usage record request failed validation', {
      issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), code: issue.code })),
    });
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const { core, metadata, prior_microdollar_usage, posthog_distinct_id } = parsed.data;

  // Redelivery is handled inside the write, not by a lookup here.
  //
  // There used to be a `SELECT id FROM microdollar_usage WHERE id = $1` at this
  // point to short-circuit a redelivery that had already committed. It cost a pool
  // connection on every single request, and the in-process pool — capped at 10 per
  // instance — is the endpoint's binding constraint: the timing signal shows
  // `idle == 0` on 96-98% of sampled requests with up to 245 queued, so that
  // sub-millisecond indexed lookup was measured at a p50 of 1.1-4.5s of pure
  // acquire wait. For the common path (organization usage, or any user with prior
  // usage, where `isFirstUsage` short-circuits without querying) it was one of only
  // two acquisitions per request.
  //
  // `insertUsageRecord` already produces the identical outcome via
  // `findAlreadyRecordedUsage`, and since the primary-key conflict became
  // non-retryable it does so without burning attempts. Post-commit side effects are
  // suppressed by the same `wasRedelivery` flag that this route reads. So the
  // lookup bought a guaranteed acquire on 100% of requests to save a rolled-back
  // insert on the few percent that collide.
  //
  // The overlap case is unchanged: a redelivery arriving while the first is still
  // open could never see the uncommitted row, so it always relied on the conflict
  // path.
  const result = await saveUsageRelatedDataLocally(
    core,
    metadata,
    prior_microdollar_usage,
    posthog_distinct_id
  );
  timer.mark('write');

  // `saveUsageRelatedDataLocally` swallows database errors and returns null,
  // matching the pre-existing local behaviour. Report it as a successful HTTP
  // exchange with a negative outcome so the client does not retry a write that
  // deliberately gave up.
  //
  // Deliberately not an `unavailable` signal that would make the client write
  // locally instead: `insertUsageRecord` has already exhausted its retries against
  // this primary, and a cross-region retry from SFO would re-add the transatlantic
  // lock hold this endpoint exists to remove — at the exact moment the database is
  // least able to absorb it. The failure is reported from here via
  // `captureException` in `insertUsageRecord`.
  const response: UsageRecordResponse = result
    ? {
        // A recovered identity means an earlier delivery of this same record
        // committed while this one was in flight, which is what `duplicate`
        // describes; its post-commit side effects ran on that delivery.
        status: result.wasRedelivery ? 'duplicate' : 'recorded',
        result: {
          usageId: result.usageId,
          // `core.created_at` rather than the value the write returns: a fresh
          // insert reports `RETURNING created_at`, which PostgreSQL renders as
          // "2026-04-29 01:16:12.945+00" and which is not strict ISO 8601. It is
          // the same instant, because that column was inserted from this value.
          createdAt: core.created_at,
          newMicrodollarsUsed: result.newMicrodollarsUsed,
        },
      }
    : { status: 'not_recorded', result: null };

  reportTiming(core.id, response.status);
  return NextResponse.json(response);
}
