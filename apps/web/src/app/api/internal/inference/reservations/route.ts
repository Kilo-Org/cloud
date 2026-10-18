import { NextResponse } from 'next/server';
import { timingSafeEqual } from '@kilocode/encryption';
import { InferenceReservationCommandSchema } from '@kilocode/usage-contracts';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { isUSRegion } from '@kilocode/web-shared/lib/drizzle';
import {
  admitPrepaidInference,
  executeLocalInferenceReservation,
} from '@kilocode/web-shared/lib/ai-gateway/prepaid-inference';

export const maxDuration = 10;

export async function POST(request: Request) {
  const secret = request.headers.get('x-internal-api-key');
  if (!INTERNAL_API_SECRET || !secret || !timingSafeEqual(secret, INTERNAL_API_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (isUSRegion()) {
    return NextResponse.json({ error: 'Primary-region admission required' }, { status: 503 });
  }
  const parsed = InferenceReservationCommandSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  try {
    if (parsed.data.action === 'admit') {
      const admission = await admitPrepaidInference({
        ...parsed.data,
        zeroCost: false,
        signal: request.signal,
      });
      if (admission.kind === 'rejected') return admission.response;
      return NextResponse.json({ ...admission, body: parsed.data.body });
    }
    return NextResponse.json(await executeLocalInferenceReservation(parsed.data));
  } catch {
    return NextResponse.json(
      { error: 'Credit authorization unavailable' },
      { status: 503, headers: { 'retry-after': '1' } }
    );
  }
}
