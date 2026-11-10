import { authorizeInternalApiRequest } from '@/lib/internal-api-auth';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { saveUsageRelatedDataLocally } from '@kilocode/web-shared/lib/ai-gateway/processUsage';
import { UsageRecordRequestSchema, type UsageRecordResponse } from '@kilocode/usage-contracts';
import { queueWriterAdmission } from '@kilocode/web-shared/lib/ai-gateway/usage-writer-admission';
import {
  createPhaseTimer,
  emitUsageRecordTiming,
  readPoolGauges,
  shouldEmitUsageRecordTiming,
} from '@kilocode/web-shared/lib/ai-gateway/usage-record-diagnostics';

/**
 * Frankfurt-local sink for usage writes against the PostgreSQL primary.
 *
 * `writer_caller` comes from `x-usage-write-source`: `queue` (the usage-ingest
 * consumer), `queue_vercel` (the staging Vercel queue consumer),
 * `region_handoff` (an SFO `kilocode-ai-gateway` handoff through
 * `recordUsageInPrimaryRegion`), or `unknown` when that header is missing or
 * any other value. Executing the write here collapses the row-lock hold on
 * `kilocode_users` / `organizations` / `organization_user_usage` from hundreds
 * of milliseconds to single-digit milliseconds. See `usage-record-client.ts`
 * for the `region_handoff` caller.
 *
 * This route only does the right thing on a deployment whose functions run in
 * Frankfurt. `APP_URL` points at `kilocode-app`, which is Frankfurt-only, and
 * whose rewrites do not divert `/api/internal/*`.
 */

// The usage transaction can legitimately block on a contended counter row up to
// the database `statement_timeout` ceiling of 120s. Allow more than that so a
// slow write is reported rather than silently truncated into a lost billing row.
export const maxDuration = 150;

const POOL_WAITING_SAMPLE_INTERVAL_MS = 100;
const QUEUE_ADMISSION_MAX_WAIT_MS = 250;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const unauthorized = authorizeInternalApiRequest(request);
  if (unauthorized) return unauthorized;

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
    try {
      emitUsageRecordTiming({
        usageId,
        outcome,
        totalMs,
        phases: timer.phases(),
        poolBefore,
        poolAfter: samplePool(),
        poolWaitingPeak,
      });
    } catch (error) {
      // Diagnostics must not turn a committed write into a retryable failure.
      console.warn('usage record timing emission failed', {
        usageId,
        outcome,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
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

  const { core, metadata, prior_microdollar_usage, posthog_distinct_id, bouncer_usage_event } =
    parsed.data;
  const source = request.headers.get('x-usage-write-source');
  const admission =
    source === 'queue' || source === 'queue_vercel'
      ? await queueWriterAdmission.acquire(source, core.id, {
          maxWaitMs: QUEUE_ADMISSION_MAX_WAIT_MS,
          signal: request.signal,
        })
      : null;
  if (admission && !admission.admitted) {
    return NextResponse.json(
      { error: 'Usage writer overloaded', reason: admission.reason },
      { status: 429 }
    );
  }
  if (admission) timer.mark('admission');

  // Redelivery is handled inside the write, not by a lookup here.
  // Sample on an interval: waiting peaks during the write, not at its endpoints.
  const poolSampler = setInterval(samplePool, POOL_WAITING_SAMPLE_INTERVAL_MS);
  let result: Awaited<ReturnType<typeof saveUsageRelatedDataLocally>>;
  try {
    result = await saveUsageRelatedDataLocally(
      core,
      metadata,
      prior_microdollar_usage,
      posthog_distinct_id,
      bouncer_usage_event ?? null,
      {
        entrypoint: 'writer_endpoint',
        writer_caller:
          source === 'queue' || source === 'queue_vercel' || source === 'region_handoff'
            ? source
            : 'unknown',
      }
    );
  } finally {
    clearInterval(poolSampler);
    // Keep the slot through actual completion, including awaited post-commit work.
    admission?.release();
  }
  timer.mark('write');

  // `saveUsageRelatedDataLocally` swallows database errors and returns null,
  // matching the pre-existing local behaviour. Report it as a successful HTTP
  // exchange with a negative outcome. `not_recorded` is not a signal to write
  // locally, and the direct client does not retry it.
  //
  // Deliberately not an `unavailable` signal. That is what tells
  // `recordUsageInPrimaryRegion` to fall back to a local write, and
  // `insertUsageRecord` has already exhausted its retries against this primary.
  // The failure is reported from here via `captureException` in
  // `insertUsageRecord`.
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
