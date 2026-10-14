import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { timingSafeEqual } from '@kilocode/encryption';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import {
  BenchmarkBillingError,
  reserveBenchmarkCredits,
  settleBenchmarkCredits,
} from '@/lib/auto-routing-benchmark-billing';

export async function handleBenchmarkBillingRequest(
  request: Request,
  operation: 'reserve' | 'settle'
) {
  const token = extractBearerToken(request.headers.get('authorization'));
  if (!INTERNAL_API_SECRET || !token || !timingSafeEqual(token, INTERNAL_API_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  try {
    return NextResponse.json(
      operation === 'reserve'
        ? await reserveBenchmarkCredits(body)
        : await settleBenchmarkCredits(body)
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    if (error instanceof BenchmarkBillingError) {
      return NextResponse.json({ error: error.code, ...error.details }, { status: error.status });
    }
    throw error;
  }
}
