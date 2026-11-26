import { NextResponse } from 'next/server';
import { matchesInternalApiSecret } from '@kilocode/web-shared/lib/internal-api-secret';

// Both headers carry the same shared secret; the two spellings come from
// different internal callers and must be accepted interchangeably.
export async function authorizeInternalApiRequest(request: Request): Promise<NextResponse | null> {
  const secret =
    request.headers.get('x-internal-api-key') ?? request.headers.get('x-internal-secret');

  if (!(await matchesInternalApiSecret(secret))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return null;
}
