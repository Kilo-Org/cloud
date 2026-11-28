import {
  browserSessionResponse,
  browserSessionSetup,
  clearedCookie,
} from '@kilocode/web-shared/lib/uts-bff/browser-session';
import { getUtsBrowserSessionStatus } from '@kilocode/web-shared/lib/user/server';

/**
 * The browser's UTS session, for the app's own pages: who it signed in and when it ends. It never
 * returns the handle, the session id or a token. A UTS cookie that names no session here any more
 * is cleared; an account the app refuses answers its status and keeps the cookie; a session that
 * could not be checked answers 503 with `Retry-After` and keeps it. 404 wherever
 * `UTS_BROWSER_SESSIONS` is off. A NextAuth session is not reported here.
 */
export async function GET(): Promise<Response> {
  const setup = browserSessionSetup();
  if (setup === null) return browserSessionResponse({ status: 404 });
  const state = await getUtsBrowserSessionStatus();
  switch (state.status) {
    case 'active':
      return browserSessionResponse({ status: 200, json: { status: 'active', ...state.session } });
    case 'unavailable':
      return browserSessionResponse({
        status: 503,
        json: { status: 'unavailable' },
        retryAfterSeconds: state.retryAfterSeconds,
      });
    case 'refused':
      return browserSessionResponse({ status: state.httpStatus, json: { status: 'refused' } });
    case 'ended':
      return browserSessionResponse({
        status: 401,
        json: { status: 'ended' },
        setCookies: [clearedCookie(setup, setup.cookies.session)],
      });
    case 'absent':
      return browserSessionResponse({ status: 401, json: { status: 'absent' } });
  }
}
