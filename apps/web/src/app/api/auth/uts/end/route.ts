import {
  browserSessionResponse,
  browserSessionSetup,
  endBrowserSession,
} from '@kilocode/web-shared/lib/uts-bff/browser-session';
import { authAuditRequestFromHeaders, recordAuthEvent } from '@/lib/auth/auth-audit';
import { isSameOriginSubmission } from '@/lib/auth/same-origin';

/**
 * Ends this browser's UTS session (design 5.6: session delete plus a feed entry) and, once UTS
 * confirms, clears its cookie and any NextAuth session cookie of the browser, so no older session
 * comes back. Other browsers, the CLI and mobile keep theirs. An end UTS could not confirm leaves
 * every cookie and answers 503 with `Retry-After`. A post from another origin is refused. 404
 * wherever `UTS_BROWSER_SESSIONS` is off.
 */
export async function POST(request: Request): Promise<Response> {
  const setup = browserSessionSetup();
  if (setup === null) return browserSessionResponse({ status: 404 });
  if (!isSameOriginSubmission(request)) {
    return browserSessionResponse({ status: 403, json: { status: 'forbidden' } });
  }
  const outcome = await endBrowserSession(setup, request.headers.get('cookie'));
  const audit = authAuditRequestFromHeaders(request.headers, '/api/auth/uts/end');
  if (outcome.kind === 'retry') {
    await recordAuthEvent(audit, {
      action: 'auth.sign_out',
      outcome: 'failure',
      method: 'uts',
      failureReason: outcome.reason,
    });
    return browserSessionResponse({
      status: 503,
      json: { status: 'retry' },
      retryAfterSeconds: outcome.retryAfterSeconds,
    });
  }
  await recordAuthEvent(audit, { action: 'auth.sign_out', outcome: 'success', method: 'uts' });
  return browserSessionResponse({
    status: 200,
    json: { status: 'ended' },
    setCookies: outcome.setCookies,
  });
}
