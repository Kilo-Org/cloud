import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  ExaUsageRecordSchema,
  ExaUsageWriteResponseSchema,
  type ExaUsageWriteResponse,
} from '@kilocode/usage-contracts';
import { authorizeInternalApiRequest } from '@/lib/internal-api-auth';
import { recordExaUsage } from '@/lib/exa-usage';
import { describeDatabaseError } from '@kilocode/web-shared/lib/ai-gateway/usage-record-diagnostics';
import { queueWriterAdmission } from '@kilocode/web-shared/lib/ai-gateway/usage-writer-admission';

/** Writes against the PostgreSQL primary, so it must run next to it. */
export const preferredRegion = 'fra1';

/** Above the database `statement_timeout` of 120s, so a slow write completes rather than being cut off. */
export const maxDuration = 150;

const QUEUE_ADMISSION_MAX_WAIT_MS = 250;

function describeBodyReadError(error: unknown) {
  // A JSON SyntaxError message quotes the request body, which must not be logged.
  if (error instanceof SyntaxError) return { error_name: error.name };
  if (error instanceof Error) return { error_name: error.name, error_message: error.message };
  return { error_name: typeof error };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const unauthorized = authorizeInternalApiRequest(request);
  if (unauthorized) return unauthorized;

  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    console.error(
      '[exa-usage] usage record request body could not be read as JSON',
      describeBodyReadError(error)
    );
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const parsed = ExaUsageRecordSchema.safeParse(body);
  if (!parsed.success) {
    console.error('[exa-usage] usage record request failed validation', {
      issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), code: issue.code })),
    });
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  const record = parsed.data;

  const admission =
    request.headers.get('x-usage-write-source') === 'queue'
      ? await queueWriterAdmission.acquire('queue', record.id, {
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

  let status: ExaUsageWriteResponse['status'];
  try {
    status = await recordExaUsage(record);
  } catch (error) {
    console.error('[exa-usage] failed to record usage in the primary region', {
      usage_id: record.id,
      error: describeDatabaseError(error),
    });
    return NextResponse.json({ error: 'Usage write failed' }, { status: 500 });
  } finally {
    admission?.release();
  }

  return NextResponse.json(ExaUsageWriteResponseSchema.parse({ status, usageId: record.id }));
}
