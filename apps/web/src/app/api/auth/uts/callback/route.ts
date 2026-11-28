import type { NextRequest } from 'next/server';
import {
  browserSessionResponse,
  browserSessionSetup,
  completeBrowserSignIn,
} from '@kilocode/web-shared/lib/uts-bff/browser-session';
import { authAuditRequestFromHeaders, recordAuthEvent } from '@/lib/auth/auth-audit';

const ROUTE = '/api/auth/uts/callback';

/**
 * The `kilo-web` redirect URI (`KILO_WEB_CALLBACK_PATH`): checks the transaction's `state` and
 * the issuer (RFC 9207), exchanges the code with the client assertion, admits the account, sets
 * the session cookie and retires the browser's NextAuth session cookies, so the browser holds one
 * session family. 404 wherever `UTS_BROWSER_SESSIONS` is off. A failed or retried callback never
 * touches the browser's existing cookies.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const setup = browserSessionSetup();
  if (setup === null) return browserSessionResponse({ status: 404 });
  const outcome = await completeBrowserSignIn(setup, {
    requestUrl: request.url,
    cookieHeader: request.headers.get('cookie'),
  });
  const audit = authAuditRequestFromHeaders(request.headers, ROUTE);

  switch (outcome.kind) {
    case 'signed_in':
      await recordAuthEvent(audit, {
        action: 'auth.sign_in',
        outcome: 'success',
        method: 'uts',
        userId: outcome.userId,
      });
      return browserSessionResponse({
        status: 303,
        location: outcome.location,
        setCookies: outcome.setCookies,
      });
    case 'retry':
      return browserSessionResponse({
        status: 503,
        text: 'The sign-in could not finish yet. Reload this page to try again.',
        retryAfterSeconds: outcome.retryAfterSeconds,
        setCookies: outcome.setCookies,
      });
    case 'restart':
      await recordAuthEvent(audit, {
        action: 'auth.sign_in',
        outcome: 'failure',
        method: 'uts',
        failureReason: outcome.reason,
      });
      return browserSessionResponse({
        status: 400,
        text: 'This sign-in can no longer finish. Start the sign-in again.',
        setCookies: outcome.setCookies,
      });
    case 'failed':
      await recordAuthEvent(audit, {
        action: 'auth.sign_in',
        outcome: 'failure',
        method: 'uts',
        failureReason: outcome.code ?? outcome.reason,
        userId: outcome.userId ?? null,
      });
      return browserSessionResponse({
        status: outcome.reason === 'account_refused' ? 403 : 400,
        text:
          outcome.reason === 'account_refused'
            ? 'This account cannot sign in here.'
            : 'The sign-in did not complete. Start the sign-in again.',
        setCookies: outcome.setCookies,
      });
  }
}
