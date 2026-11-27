import { timingSafeEqual } from '@kilocode/encryption';
import { NextResponse } from 'next/server';
import {
  INTERNAL_CALLER_HEADER,
  callerLabel,
  observeInternalAuth,
} from '@kilocode/worker-utils/internal-auth-observation';
import { readInternalApiSecret } from '@kilocode/web-shared/lib/internal-api-secret';

// Both headers carry the same shared secret; the two spellings come from
// different internal callers and must be accepted interchangeably.
//
// `route` is the receiving route family, a literal at each call site, and only labels the
// observation line (design section 9.4, item 9): one accepted request reports that a shared secret
// authenticated here, so the kill-date gate can count what still arrives that way.
export async function authorizeInternalApiRequest(
  request: Request,
  route: string
): Promise<NextResponse | null> {
  const secret =
    request.headers.get('x-internal-api-key') ?? request.headers.get('x-internal-secret');
  // A request without a credential is refused without reading the expected value.
  const expected = secret ? await readInternalApiSecret() : '';

  if (!expected || !secret || !timingSafeEqual(secret, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  observeInternalAuth(
    'web',
    route,
    'legacy_shared_secret',
    callerLabel(request.headers.get(INTERNAL_CALLER_HEADER))
  );
  return null;
}
