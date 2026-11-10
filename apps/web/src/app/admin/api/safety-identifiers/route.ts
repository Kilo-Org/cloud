import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import {
  getSafetyIdentifierStatus,
  regenerateSafetyIdentifiers,
  SAFETY_IDENTIFIER_BACKFILL_ERROR,
  SAFETY_IDENTIFIER_WORK_BUDGET_MS,
} from '@/lib/safety-identifiers';

export const maxDuration = 300;

export type SafetyIdentifierStatusResponse = Awaited<ReturnType<typeof getSafetyIdentifierStatus>>;
export type BackfillBatchResponse = { processed: number; remaining: boolean };

export async function GET(): Promise<
  NextResponse<SafetyIdentifierStatusResponse | { error: string }>
> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  try {
    return NextResponse.json(await getSafetyIdentifierStatus());
  } catch {
    return NextResponse.json({ error: SAFETY_IDENTIFIER_BACKFILL_ERROR }, { status: 500 });
  }
}

export async function POST(): Promise<NextResponse<BackfillBatchResponse | { error: string }>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  try {
    const result = await regenerateSafetyIdentifiers({
      deadlineAt: Date.now() + SAFETY_IDENTIFIER_WORK_BUDGET_MS,
    });
    if (result.skipped) {
      return NextResponse.json(
        { error: 'Safety identifier regeneration is already running' },
        {
          status: 409,
        }
      );
    }
    return NextResponse.json({ processed: result.processed, remaining: result.remaining });
  } catch {
    return NextResponse.json({ error: SAFETY_IDENTIFIER_BACKFILL_ERROR }, { status: 500 });
  }
}
