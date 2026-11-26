import { UtsFeedIndexSchema } from '@kilocode/uts-contracts';
import { withDORetry } from '@kilocode/worker-utils';
import { z } from 'zod';
import { devMetadataFetcher, devStsCallers } from './dev-clients';
import { handleDevNoticeRequest } from './dev-notices';
import type { DevUtsFeedDO } from './dev-feed';
import { getFeedStub, getSignerStub } from './dos/stubs';
import type { SignResult } from './dos/UtsSignerDO';
import { readConfig, type Env, type UtsConfig } from './env';
import { identityStoreBinding } from './grants/binding';
import { handleRequest } from './http';
import { signerForGrant } from './keys/signer-choice';
import type { AuthorizationHandoff } from './oauth/authorize';
import { jsonResponse } from './responses';
import { developmentScopes } from './scopes/development-fixtures';
import type { SignInEmail, SignInMailer } from './signin/email/mailer';
import { redeemTicket } from './tickets/routes';
import { ticketAccess } from './tickets/store';
import type { SignerAccess } from './token/mint';

/**
 * Development-only routes and hooks, for the local end-to-end checks. Only `src/dev-index.ts`
 * reaches this module, and only `wrangler.dev.jsonc` uses that entry: its build command fails every
 * Wrangler command but `dev`, so no deploy or version upload can bundle it, and `test/repo` fails
 * any other config that runs it. Each part also
 * stays off unless `UTS_ENVIRONMENT` is `development`, and a token minted here names the
 * development issuer, which no staging or production verifier accepts.
 *
 * * `POST /__dev/sign` signs a caller-supplied claim set through the signer the grant picks.
 * * `POST /__dev/feed/stop` makes one feed object fail every call for a number of seconds
 *   (`src/dev-feed.ts`), for the fail-over check of the local end-to-end run.
 * * The development sign-in hand-off approves every authorization request for one synthetic
 *   account, `DEV_ACCOUNT_ID`, signed in by passkey now, bound to the organization the request
 *   names in `org` (the identity store checks the membership). `dev_decision=deny` on the
 *   authorization request denies it, and a third-party request names its consent in
 *   `dev_consent_id`. The account and any consent must exist in the local identity store. An
 *   authorization request with `dev_handoff=signin` uses the deployed sign-in pages instead, for
 *   the passkey and the provider end-to-end runs.
 * * The OAuth endpoints apply the scope registry plus the development fixture scopes
 *   (`fixture:*`, `src/scopes/development-fixtures.ts`), so the local run has a third-party-safe
 *   scope.
 * * The email sign-in's mail port records each message in the isolate instead of sending it, and
 *   `GET /__dev/mail?to=<address>` answers the newest message for that address (its link and code
 *   are synthetic local values), for the email end-to-end run.
 * * The notice routes under `/__dev/notices/` and the security view with a development caller
 *   check (`src/dev-notices.ts`).
 * * The client metadata fetch of test domains and the stand-in STS token verifier of the broker
 *   exchange, each when its var is set (`src/dev-clients.ts`).
 */
export const DEV_SIGN_PATH = '/__dev/sign';
export const DEV_FEED_STOP_PATH = '/__dev/feed/stop';
export const DEV_MAIL_PATH = '/__dev/mail';

/**
 * `POST /__dev/tickets/redeem` with `{ ticket, audience }` redeems as the development redeemer
 * `uts-ticket-test`, as its `TicketRedeemer` binding would, for the local end-to-end run, which
 * cannot hold a service binding.
 */
export const DEV_TICKET_REDEEM_PATH = '/__dev/tickets/redeem';
const DevRedeemSchema = z.strictObject({ ticket: z.unknown(), audience: z.unknown() });

async function handleDevTicketRedeem(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  config: UtsConfig
): Promise<Response> {
  const binding = identityStoreBinding(env);
  const body = DevRedeemSchema.safeParse(await request.json().catch(() => undefined));
  if (request.method !== 'POST' || binding.kind === 'unprovisioned' || !body.success) {
    return jsonResponse({ error: 'invalid_request' }, 400);
  }
  const result = await redeemTicket(
    { config, tickets: ticketAccess(binding.connectionString, ctx) },
    'uts-ticket-test',
    body.data.ticket,
    body.data.audience
  );
  return jsonResponse(result, result.status === 'redeemed' ? 200 : 400);
}

/** The synthetic account the development hand-off signs in. */
export const DEV_ACCOUNT_ID = 'dev:uts-local';

const outbox = new Map<string, SignInEmail>();

const recordingMailer: SignInMailer = async message => {
  outbox.set(message.to, message);
  return 'sent';
};

const DevSignRequestSchema = z.strictObject({
  grantId: z.string().min(1),
  claims: z.unknown(),
});

const DevFeedStopSchema = z.strictObject({
  feed: UtsFeedIndexSchema,
  seconds: z.number().int().min(1).max(300),
});

async function stopFeedObject(request: Request, env: Env, config: UtsConfig): Promise<Response> {
  const body = DevFeedStopSchema.safeParse(await request.json().catch(() => undefined));
  if (!body.success) return jsonResponse({ error: 'invalid_request' }, 400);
  const until = Date.now() + body.data.seconds * 1000;
  // The local entry exports `DevUtsFeedDO` as `UtsFeedDO` (src/dev-index.ts), so the objects of
  // this namespace have `devStop`; the binding's type names the deployed class.
  const stub = getFeedStub(
    env,
    config,
    body.data.feed
  ) as unknown as DurableObjectStub<DevUtsFeedDO>;
  const result = await stub.devStop(until);
  return jsonResponse({ feed: body.data.feed, result, until }, result === 'stopped' ? 200 : 400);
}

export const developmentHandoff: AuthorizationHandoff = async (request, pending) => {
  const params = new URL(request.url).searchParams;
  if (params.get('dev_decision') === 'deny') return { status: 'denied' };
  const subject = {
    accountId: DEV_ACCOUNT_ID,
    browserSessionId: null,
    authTime: new Date(),
    amr: ['passkey'] as const,
    orgId: pending.orgHint,
  };
  if (pending.client.kind === 'first_party') {
    return { status: 'approved', approval: { ...subject, clientKind: 'first_party' } };
  }
  const consentId = z.uuid().safeParse(params.get('dev_consent_id'));
  if (!consentId.success) return { status: 'denied' };
  return {
    status: 'approved',
    approval: { ...subject, clientKind: 'third_party', consentId: consentId.data },
  };
};

export async function handleDevRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const config = readConfig(env);
  if (config.environment !== 'development') return await handleRequest(request, env, ctx);
  const { pathname, searchParams } = new URL(request.url);
  const notices = await handleDevNoticeRequest(request, pathname, env, ctx);
  if (notices !== null) return notices;
  if (pathname === DEV_FEED_STOP_PATH && request.method === 'POST') {
    return await stopFeedObject(request, env, config);
  }
  if (pathname === DEV_MAIL_PATH) {
    const message = outbox.get(searchParams.get('to') ?? '');
    return message === undefined
      ? jsonResponse({ error: 'not_found' }, 404)
      : jsonResponse(message, 200);
  }
  if (pathname === DEV_TICKET_REDEEM_PATH) {
    return await handleDevTicketRedeem(request, env, ctx, config);
  }
  if (pathname !== DEV_SIGN_PATH) {
    // `Kilo-Dev-Signing: unavailable` makes every signer call of the request fail after the grant
    // statement, as a signer object that does not answer would, for the retry check of the local
    // end-to-end run.
    const signer: SignerAccess | null =
      request.headers.get('Kilo-Dev-Signing') === 'unavailable'
        ? async () => ({ status: 'unavailable' })
        : null;
    return await handleRequest(request, env, ctx, {
      authorizationHandoff: signInPages => async (authorization, pending) =>
        new URL(authorization.url).searchParams.get('dev_handoff') === 'signin'
          ? await signInPages(authorization, pending)
          : await developmentHandoff(authorization, pending),
      signer,
      scopes: developmentScopes,
      mailer: recordingMailer,
      metadataFetcher: devMetadataFetcher(env) ?? ((url, init) => fetch(url, init)),
      stsCallers: devStsCallers(env),
    });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  }
  const body = DevSignRequestSchema.safeParse(await request.json().catch(() => undefined));
  if (!body.success) return jsonResponse({ error: 'invalid_request' }, 400);
  const signer = await signerForGrant(body.data.grantId);
  const result = await withDORetry(
    () => getSignerStub(env, config, signer),
    async (stub): Promise<SignResult> => await stub.sign(body.data.claims),
    'uts.dev.sign'
  );
  if (result.status === 'refused') return jsonResponse({ error: result.reason }, 400);
  if (result.status === 'misconfigured') return jsonResponse({ error: 'server_error' }, 500);
  return jsonResponse({ signer, kid: result.kid, token: result.token }, 200);
}
