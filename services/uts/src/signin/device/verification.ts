import { z } from 'zod';
import { identifyClient } from '../../oauth/clients';
import { classifyFailure } from '../../oauth/errors';
import { jsonResponse } from '../../responses';
import { sha256 } from '../../token/credentials';
import { requestSession } from '../handoff';
import {
  deviceApprovalPage,
  deviceCodeEntryPage,
  deviceMessagePage,
  signInPage,
  unavailablePage,
} from '../pages';
import { readSameOriginJson } from '../requests';
import { sessionCookieValue } from '../session';
import type { DeviceDeps } from './authorization';
import { formatUserCode, importUserCodeKey, normalizeUserCode, userCodeHash } from './user-code';

/**
 * The device verification page (RFC 8628 section 3.3) and its decision. The user signs in on the
 * page if needed, enters the code (or arrives with it in `user_code`), sees what asks and from
 * where (section 5.4), and approves or denies. An approval needs the tier B check (design 5.11):
 * a sign-in within 10 minutes, else the page asks for a passkey step-up and sends the decision
 * again.
 */

const DecisionSchema = z.strictObject({
  user_code: z.string().max(32),
  approve: z.boolean(),
});

const UNKNOWN_CODE = 'That code is unknown or has expired. Check the code on your device.';
const TOO_MANY = 'Too many wrong codes. Try again in an hour.';

/** GET /device, with or without `user_code`. Each view runs one statement. */
export async function handleDevicePage(request: Request, deps: DeviceDeps): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
  }
  const entered = new URL(request.url).searchParams.get('user_code');
  const cookie = sessionCookieValue(request);
  if (cookie === null) return signInPage();
  try {
    if (entered === null || entered === '') {
      const session = await requestSession(request, deps);
      return session === null ? signInPage() : deviceCodeEntryPage(null);
    }
    const normalized = normalizeUserCode(entered);
    if (normalized === null) return deviceCodeEntryPage(UNKNOWN_CODE);
    const key = await importUserCodeKey(deps.userCodeSecret);
    const codeHash = await userCodeHash(key, normalized);
    const sessionHash = await sha256(cookie);
    const read = await deps.signIn(store => store.readDeviceCode(codeHash, sessionHash));
    switch (read.outcome) {
      case 'pending': {
        const client = identifyClient(read.clientId);
        const name = client.kind === 'first_party' ? client.client.name : read.clientId;
        return deviceApprovalPage(formatUserCode(normalized), name, read);
      }
      case 'no_session':
        return signInPage();
      case 'unknown_code':
        return deviceCodeEntryPage(UNKNOWN_CODE);
      case 'too_many_attempts':
        return deviceMessagePage(TOO_MANY, 429);
    }
  } catch (error) {
    return unavailablePage(classifyFailure(error, 'device_page') === 'retryable');
  }
}

const DECISION_STATUS = {
  approved: 200,
  denied: 200,
  no_session: 401,
  unknown_code: 404,
  too_many_attempts: 429,
  gate_required: 403,
} as const;

/** POST /device/decision from the approval page: `{ user_code, approve }`. */
export async function handleDeviceDecision(request: Request, deps: DeviceDeps): Promise<Response> {
  const body = await readSameOriginJson(request, DecisionSchema, 1024);
  if (body instanceof Response) return body;
  const cookie = sessionCookieValue(request);
  if (cookie === null) return jsonResponse({ error: 'no_session' }, 401);
  const normalized = normalizeUserCode(body.user_code);
  if (normalized === null) return jsonResponse({ error: 'unknown_code' }, 404);
  try {
    const key = await importUserCodeKey(deps.userCodeSecret);
    const codeHash = await userCodeHash(key, normalized);
    const sessionHash = await sha256(cookie);
    const outcome = await deps.signIn(store =>
      store.decideDeviceCode({
        environment: deps.config.environment,
        userCodeHash: codeHash,
        sessionTokenHash: sessionHash,
        approve: body.approve,
      })
    );
    const status = DECISION_STATUS[outcome];
    return jsonResponse(status === 200 ? { outcome } : { error: outcome }, status);
  } catch (error) {
    const retryable = classifyFailure(error, 'device_decision') === 'retryable';
    return jsonResponse(
      { error: retryable ? 'temporarily_unavailable' : 'server_error' },
      retryable ? 503 : 500,
      retryable ? { 'Retry-After': '2' } : {}
    );
  }
}
