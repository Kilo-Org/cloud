import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { authorizeInternalApiRequest } from '@/lib/internal-api-auth';
import { describeDatabaseError } from '@kilocode/web-shared/lib/ai-gateway/usage-record-diagnostics';
import { queueWriterAdmission } from '@kilocode/web-shared/lib/ai-gateway/usage-writer-admission';
import { recordEnkryptUsageLocally } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage';
import {
  EnkryptUsageWriteSchema,
  type EnkryptUsageWriteResponse,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage-write';

/** Receives `recordEnkryptUsageInPrimaryRegion` handoffs; must run next to the PostgreSQL primary. */
export const preferredRegion = 'fra1';

/** Above the database `statement_timeout` of 120s, so a slow write completes rather than being cut off. */
export const maxDuration = 150;

const QUEUE_ADMISSION_MAX_WAIT_MS = 250;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const unauthorized = authorizeInternalApiRequest(request);
  if (unauthorized) return unauthorized;

  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    // A JSON SyntaxError message quotes the request body, which must not be logged.
    console.error('[enkrypt-guardrail] usage handoff request body could not be read as JSON', {
      error_name: error instanceof Error ? error.name : typeof error,
    });
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const parsed = EnkryptUsageWriteSchema.safeParse(body);
  if (!parsed.success) {
    console.error('[enkrypt-guardrail] usage handoff request failed validation', {
      issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), code: issue.code })),
    });
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  const usageId = parsed.data.id;

  const admission =
    request.headers.get('x-usage-write-source') === 'queue'
      ? await queueWriterAdmission.acquire('queue', usageId, {
          maxWaitMs: QUEUE_ADMISSION_MAX_WAIT_MS,
          signal: request.signal,
          writerClass: 'non_llm',
        })
      : null;
  if (admission && !admission.admitted) {
    return NextResponse.json(
      { error: 'Usage writer overloaded', reason: admission.reason },
      { status: 429 }
    );
  }

  try {
    const status = await recordEnkryptUsageLocally(parsed.data);
    return NextResponse.json({ status, usageId } satisfies EnkryptUsageWriteResponse);
  } catch (error) {
    console.error('[enkrypt-guardrail] failed to record usage in the primary region', {
      usage_id: usageId,
      error: describeDatabaseError(error),
    });
    return NextResponse.json({ error: 'Usage write failed' }, { status: 500 });
  } finally {
    admission?.release();
  }
}
