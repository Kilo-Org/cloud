import { ReadmitBenchmarkProfileRequestSchema } from '@kilocode/auto-routing-contracts';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { readmitBenchmarkProfile } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';

/** Re-admit one failed registry pair, clearing its failure history. */
export async function POST(request: NextRequest) {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = ReadmitBenchmarkProfileRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid re-admit request' }, { status: 400 });
  }

  const result = await readmitBenchmarkProfile(parsed.data.entry, parsed.data.router);
  return NextResponse.json(result.body, { status: result.status });
}
