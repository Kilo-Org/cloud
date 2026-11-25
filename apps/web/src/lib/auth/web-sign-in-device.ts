import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import * as z from 'zod';
import { IS_DEVELOPMENT } from '@kilocode/web-shared/lib/constants';
import type { SignInDevice } from '@/lib/auth/sign-in-context';

/**
 * The browser device cookie: 32 random bytes that identify one browser for
 * new-sign-in detection. Only its hash is stored. It is set on the response
 * of the NextAuth callback that signs the browser in, so the value the
 * detection records is the value the browser holds from then on.
 *
 * NextAuth builds its own response, so the callback cannot set a cookie on
 * it; the NextAuth route runs the handler inside `withWebSignInDevice`, the
 * `jwt` callback claims the device through `claimWebSignInDevice`, and the
 * route then adds the cookie to the response it returns.
 */
export const WEB_SIGN_IN_DEVICE_COOKIE = IS_DEVELOPMENT ? 'kilo-device' : '__Host-kilo-device';
/** The longest lifetime browsers accept for a cookie. */
const WEB_SIGN_IN_DEVICE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

const deviceSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

type WebSignInScope = { secret: string; headers: Headers; claimed: boolean };

const scope = new AsyncLocalStorage<WebSignInScope>();

/**
 * Runs one NextAuth request with the browser's device cookie in scope (a new
 * value when the request carries none or a malformed one). When a sign-in
 * claimed the device, the returned response sets the cookie, refreshing its
 * lifetime; any other response is returned unchanged.
 */
export async function withWebSignInDevice(
  request: NextRequest,
  handler: () => Promise<Response>
): Promise<Response> {
  const current = deviceSecretSchema.safeParse(
    request.cookies.get(WEB_SIGN_IN_DEVICE_COOKIE)?.value
  );
  const state: WebSignInScope = {
    secret: current.success ? current.data : randomBytes(32).toString('base64url'),
    headers: request.headers,
    claimed: false,
  };
  const response = await scope.run(state, handler);
  if (!state.claimed) return response;

  const withCookie = new NextResponse(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  withCookie.cookies.set(WEB_SIGN_IN_DEVICE_COOKIE, state.secret, {
    path: '/',
    httpOnly: true,
    secure: !IS_DEVELOPMENT,
    sameSite: 'lax',
    maxAge: WEB_SIGN_IN_DEVICE_MAX_AGE_SECONDS,
  });
  return withCookie;
}

/**
 * The device and headers of the browser sign-in in progress, and a mark that
 * the response must set the device cookie. Null outside a NextAuth request.
 */
export function claimWebSignInDevice(): { device: SignInDevice; headers: Headers } | null {
  const state = scope.getStore();
  if (!state) return null;
  state.claimed = true;
  return { device: { kind: 'browser_cookie', secret: state.secret }, headers: state.headers };
}
