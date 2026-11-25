import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { NextRequest } from 'next/server';
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
 *
 * In production the cookie is `SameSite=None`: Apple returns to the callback
 * with a cross-site form POST, which carries no `Lax` cookie. The cookie only
 * identifies the browser and grants nothing, so sending it cross-site is
 * harmless. `None` requires `Secure`, which a development server on plain
 * HTTP cannot set, so development keeps `Lax`.
 */
export const WEB_SIGN_IN_DEVICE_COOKIE = IS_DEVELOPMENT ? 'kilo-device' : '__Host-kilo-device';
/** The longest lifetime browsers accept for a cookie. */
const WEB_SIGN_IN_DEVICE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

const deviceSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

type WebSignInScope = {
  /** The well-formed device cookie the request carries, if any. */
  current: string | null;
  headers: Headers;
  /** The device a sign-in claimed; the response sets it as the cookie. */
  claimed: string | null;
};

const scope = new AsyncLocalStorage<WebSignInScope>();

function deviceCookie(secret: string): string {
  const attributes = [
    `${WEB_SIGN_IN_DEVICE_COOKIE}=${secret}`,
    'Path=/',
    `Max-Age=${WEB_SIGN_IN_DEVICE_MAX_AGE_SECONDS}`,
    'HttpOnly',
    ...(IS_DEVELOPMENT ? ['SameSite=Lax'] : ['Secure', 'SameSite=None']),
  ];
  return attributes.join('; ');
}

/**
 * Runs one NextAuth request with the browser's device cookie in scope. When a
 * sign-in claimed the device, the returned response also sets the cookie,
 * refreshing its lifetime; any other response is returned unchanged.
 *
 * The cookie is appended to a copy of NextAuth's headers, so every
 * Set-Cookie NextAuth wrote (session token, cleared cookies) passes through
 * byte for byte.
 */
export async function withWebSignInDevice(
  request: NextRequest,
  handler: () => Promise<Response>
): Promise<Response> {
  const current = deviceSecretSchema.safeParse(
    request.cookies.get(WEB_SIGN_IN_DEVICE_COOKIE)?.value
  );
  const state: WebSignInScope = {
    current: current.success ? current.data : null,
    headers: request.headers,
    claimed: null,
  };
  const response = await scope.run(state, handler);
  if (state.claimed === null) return response;

  const headers = new Headers(response.headers);
  headers.append('set-cookie', deviceCookie(state.claimed));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * The device and headers of the browser sign-in in progress, and a mark that
 * the response must set the device cookie: the browser's cookie, or a new
 * value when it carries none or a malformed one. Null outside a NextAuth
 * request.
 */
export function claimWebSignInDevice(): { device: SignInDevice; headers: Headers } | null {
  const state = scope.getStore();
  if (!state) return null;
  state.claimed ??= state.current ?? randomBytes(32).toString('base64url');
  return { device: { kind: 'browser_cookie', secret: state.claimed }, headers: state.headers };
}
