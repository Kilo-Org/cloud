import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { authorizeInternalApiRequest } from '@/lib/internal-api-auth';
import { describeDatabaseError } from '@kilocode/web-shared/lib/ai-gateway/usage-record-diagnostics';
import { recordEnkryptUsageLocally } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage';
import {
  EnkryptUsageWriteSchema,
  type EnkryptUsageWriteResponse,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage-write';

/** Receives `recordEnkryptUsageInPrimaryRegion` handoffs; must run next to the PostgreSQL primary. */
export const preferredRegion = 'fra1';

/** Above the database `statement_timeout` of 120s, so a slow write completes rather than being cut off. */
export const maxDuration = 150;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const unauthorized = authorizeInternalApiRequest(request);
  if (unauthorized) return unauthorized;

  const parsed = EnkryptUsageWriteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    console.error('[enkrypt-guardrail] usage handoff request failed validation', {
      issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), code: issue.code })),
    });
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  try {
    const status = await recordEnkryptUsageLocally(parsed.data);
    return NextResponse.json({ status } satisfies EnkryptUsageWriteResponse);
  } catch (error) {
    console.error('[enkrypt-guardrail] failed to record usage in the primary region', {
      usage_id: parsed.data.id,
      error: describeDatabaseError(error),
    });
    return NextResponse.json({ error: 'Usage write failed' }, { status: 500 });
  }
}
