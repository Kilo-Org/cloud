import { timingSafeEqual } from '@kilocode/encryption';
import { NextResponse } from 'next/server';
import { readInternalApiSecret } from '@kilocode/web-shared/lib/internal-api-secret';

// Both headers carry the same shared secret; the two spellings come from
// different internal callers and must be accepted interchangeably.
export async function authorizeInternalApiRequest(request: Request): Promise<NextResponse | null> {
  const secret =
    request.headers.get('x-internal-api-key') ?? request.headers.get('x-internal-secret');
  // A request without a credential is refused without reading the expected value.
  const expected = secret ? await readInternalApiSecret() : '';

  if (!expected || !secret || !timingSafeEqual(secret, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return null;
}
