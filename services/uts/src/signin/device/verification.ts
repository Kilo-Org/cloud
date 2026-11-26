import { UTS_DEVICE_VERIFICATION_PATH } from '@kilocode/uts-contracts';
import { z } from 'zod';
import { identifyClient } from '../../oauth/clients';
import { classifyFailure } from '../../oauth/errors';
import { readForm } from '../../oauth/params';
import { jsonResponse } from '../../responses';
import { sha256 } from '../../token/credentials';
import { requestSession } from '../handoff';
import { requestNetwork } from '../network';
import {
  deviceApprovalPage,
  deviceCodeEntryPage,
  deviceMessagePage,
  signInPage,
  unavailablePage,
} from '../pages';
import { isSameOriginPost, readSameOriginJson } from '../requests';
import { sessionCookieValue } from '../session';
import type { UserCodeSource } from '../store';
import type { DeviceDeps } from './authorization';
import { formatUserCode, importUserCodeKey, normalizeUserCode, userCodeHash } from './user-code';

/**
 * The device verification page (RFC 8628 section 3.3) and its decision. The user signs in on the
 * page if needed and enters the code; a code in the URL's `user_code` only fills the field. The
 * page posts the code back to itself from this origin, and only that POST looks the code up and
 * counts a wrong one, so a link from another site cannot use up the account's wrong codes. The
 * approval page shows what asks and from where (section 5.4); the user approves or denies. An
 * approval needs the tier B check (design 5.11): a passkey step-up of the session within 10
 * minutes, or, for a code the user typed, a sign-in within 10 minutes; otherwise the page asks
 * for the step-up and sends the decision again.
 */

const DecisionSchema = z.strictObject({
  user_code: z.string().max(32),
  source: z.enum(['typed', 'link']),
  approve: z.boolean(),
});

const UNKNOWN_CODE = 'That code is unknown or has expired. Check the code on your device.';
const TOO_MANY = 'Too many wrong codes. Try again in an hour.';

/** GET /device shows the code entry page; POST /device, from that page, looks the code up. */
export async function handleDevicePage(request: Request, deps: DeviceDeps): Promise<Response> {
  if (request.method === 'GET') return await showEntryPage(request, deps);
  if (request.method === 'POST') return await lookUpCode(request, deps);
  return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'GET, POST' });
}

/** The sign-in page, or the entry page with the URL's code filled in. One statement. */
async function showEntryPage(request: Request, deps: DeviceDeps): Promise<Response> {
  if (sessionCookieValue(request) === null) return signInPage();
  const linked = normalizeUserCode(new URL(request.url).searchParams.get('user_code') ?? '');
  try {
    const session = await requestSession(request, deps);
    if (session === null) return signInPage();
    return deviceCodeEntryPage(null, linked === null ? null : formatUserCode(linked));
  } catch (error) {
    return unavailablePage(classifyFailure(error, 'device_page') === 'retryable');
  }
}

/**
 * The entry page's POST: `user_code`, and `linked_code` when the URL filled the field. The code
 * counts as typed unless it is the linked one. Without a live session the browser goes back to
 * the entry page, which signs the user in first. One statement.
 */
async function lookUpCode(request: Request, deps: DeviceDeps): Promise<Response> {
  if (!isSameOriginPost(request)) return deviceMessagePage('Open this page again.', 403);
  const entryPage = new URL(UTS_DEVICE_VERIFICATION_PATH, request.url).toString();
  const cookie = sessionCookieValue(request);
  if (cookie === null) return Response.redirect(entryPage, 303);
  const form = await readForm(request);
  if (form.status === 'invalid') return deviceMessagePage('Open this page again.', 400);
  const entered = form.params.one('user_code');
  const normalized = entered.status === 'present' ? normalizeUserCode(entered.value) : null;
  if (normalized === null) return deviceCodeEntryPage(UNKNOWN_CODE, null);
  const linkedParam = form.params.one('linked_code');
  const source: UserCodeSource =
    linkedParam.status === 'present' && normalizeUserCode(linkedParam.value) === normalized
      ? 'link'
      : 'typed';
  try {
    const key = await importUserCodeKey(deps.userCodeSecret);
    const entry = {
      userCodeHash: await userCodeHash(key, normalized),
      sessionTokenHash: await sha256(cookie),
      clientIp: requestNetwork(request).clientIp,
    };
    const read = await deps.signIn(store => store.readDeviceCode(entry));
    switch (read.outcome) {
      case 'pending': {
        const client = identifyClient(read.clientId);
        const name = client.kind === 'first_party' ? client.client.name : read.clientId;
        return deviceApprovalPage(formatUserCode(normalized), source, name, read);
      }
      case 'no_session':
        return Response.redirect(entryPage, 303);
      case 'unknown_code':
        return deviceCodeEntryPage(UNKNOWN_CODE, null);
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

/** POST /device/decision from the approval page: `{ user_code, source, approve }`. */
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
        clientIp: requestNetwork(request).clientIp,
        source: body.source,
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
