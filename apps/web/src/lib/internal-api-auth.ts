import { timingSafeEqual } from '@kilocode/encryption';
import { NextResponse } from 'next/server';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';

// Both headers carry the same shared secret; the two spellings come from
// different internal callers and must be accepted interchangeably.
export function authorizeInternalApiRequest(request: Request): NextResponse | null {
  const secret =
    request.headers.get('x-internal-api-key') ?? request.headers.get('x-internal-secret');

  if (!INTERNAL_API_SECRET || !secret || !timingSafeEqual(secret, INTERNAL_API_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return null;
}
