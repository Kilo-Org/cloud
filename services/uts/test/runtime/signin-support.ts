import type { SignInDeps } from '../../src/signin/deps';
import type { DeviceDeps } from '../../src/signin/device/authorization';
import type { SignInAccess, SignInStore } from '../../src/signin/store';
import type { TicketDeps } from '../../src/tickets/routes';
import type { TicketAccess, TicketStore } from '../../src/tickets/store';
import { config } from './test-env';

/** Helpers for the sign-in runtime tests: recording sign-in and ticket stores, requests. */

export type Call = { method: string; input: unknown[] };

/**
 * One store method that answers with `run` and records each call. A method the test does not
 * implement fails the request, so a test sees any statement the endpoint was not meant to run.
 */
function recorded<Input extends unknown[], Output>(
  method: string,
  calls: Call[],
  run: ((...input: Input) => Promise<Output>) | undefined
): (...input: Input) => Promise<Output> {
  return async (...input) => {
    calls.push({ method, input });
    if (run === undefined) throw new Error(`unexpected ${method} call`);
    return await run(...input);
  };
}

export function fakeSignIn(implementation: Partial<SignInStore> = {}) {
  const calls: Call[] = [];
  const store: SignInStore = {
    readSession: recorded('readSession', calls, implementation.readSession),
    createChallenge: recorded('createChallenge', calls, implementation.createChallenge),
    readAssertion: recorded('readAssertion', calls, implementation.readAssertion),
    completeSignIn: recorded('completeSignIn', calls, implementation.completeSignIn),
    completeStepUp: recorded('completeStepUp', calls, implementation.completeStepUp),
    recordPasskeyFailure: recorded(
      'recordPasskeyFailure',
      calls,
      implementation.recordPasskeyFailure
    ),
    registerPasskey: recorded('registerPasskey', calls, implementation.registerPasskey),
    createDeviceCode: recorded('createDeviceCode', calls, implementation.createDeviceCode),
    readDeviceCode: recorded('readDeviceCode', calls, implementation.readDeviceCode),
    decideDeviceCode: recorded('decideDeviceCode', calls, implementation.decideDeviceCode),
    exchangeDeviceCode: recorded('exchangeDeviceCode', calls, implementation.exchangeDeviceCode),
  };
  const access: SignInAccess = work => work(store);
  const deps: SignInDeps = { config, signIn: access };
  return { deps, calls };
}

/** A synthetic user-code secret: 32 bytes of zeros in base64url. */
export const USER_CODE_SECRET = 'A'.repeat(43);

export function deviceDeps(signIn: SignInDeps): DeviceDeps {
  return { ...signIn, userCodeSecret: USER_CODE_SECRET };
}

export function fakeTickets(implementation: Partial<TicketStore> = {}) {
  const calls: Call[] = [];
  const store: TicketStore = {
    issue: recorded('issue', calls, implementation.issue),
    redeem: recorded('redeem', calls, implementation.redeem),
  };
  const access: TicketAccess = work => work(store);
  const deps: TicketDeps = { config, tickets: access };
  return { deps, calls };
}

/** The issuer origin the sign-in pages run on in the test config. */
export const ORIGIN = new URL(config.endpoints.issuer).origin;

/** A JSON POST from a sign-in page: same origin, the session cookie when given. */
export function pageJson(
  path: string,
  body: unknown,
  options: { cookie?: string; origin?: string | null; contentType?: string } = {}
): Request {
  const headers: Record<string, string> = {
    'Content-Type': options.contentType ?? 'application/json',
  };
  if (options.origin !== null) headers.Origin = options.origin ?? ORIGIN;
  if (options.cookie !== undefined) headers.Cookie = `__Host-uts_session=${options.cookie}`;
  return new Request(`${config.endpoints.issuer}${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers,
  });
}

/** A form POST from a sign-in page: same origin unless given, the session cookie when given. */
export function pageForm(
  path: string,
  fields: Record<string, string>,
  options: { cookie?: string; origin?: string; clientIp?: string } = {}
): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: options.origin ?? ORIGIN,
  };
  if (options.cookie !== undefined) headers.Cookie = `__Host-uts_session=${options.cookie}`;
  if (options.clientIp !== undefined) headers['CF-Connecting-IP'] = options.clientIp;
  return new Request(`${config.endpoints.issuer}${path}`, {
    method: 'POST',
    body: new URLSearchParams(fields).toString(),
    headers,
  });
}
