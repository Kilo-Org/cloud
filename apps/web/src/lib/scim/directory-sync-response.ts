import { NextResponse } from 'next/server';

import { DirectorySyncConflictError } from './directory-sync';

/**
 * Maps a directory-sync write failure to a response the Worker can act on.
 *
 * A conflict means the directory state cannot be applied yet — an event
 * arriving before the directory or user it depends on, or a group whose parent
 * is itself a sub-organization. 409 tells the caller to leave its cursor where
 * it is and retry, which is how out-of-order delivery recovers. Anything else
 * is 500 and equally retryable, but not expected.
 *
 * The message is returned for 409 because it names the missing dependency and
 * the caller logs it. A 500 returns a fixed string: an unexpected failure can
 * carry driver detail, including SQL and parameters, which belongs in the
 * server log rather than a response body.
 */
export function directorySyncErrorResponse(
  operation: string,
  identifier: string,
  error: unknown
): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[scim] directory sync write failed', { operation, identifier, error: message });

  if (error instanceof DirectorySyncConflictError) {
    return NextResponse.json({ error: message }, { status: 409 });
  }
  return NextResponse.json({ error: 'Directory sync write failed' }, { status: 500 });
}
