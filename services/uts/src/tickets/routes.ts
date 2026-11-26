import {
  type TicketRedemption,
  type TicketResponse,
  type UtsEnvironment,
  UTS_TICKET_LIFETIME_SECONDS,
  UTS_TICKETS_PATH,
  UtsAudienceSchema,
  UtsTicketPurposeSchema,
  UtsTicketResourceSchema,
  audienceOfResource,
} from '@kilocode/uts-contracts';
import type { UtsConfig } from '../env';
import { requestFirstPartyClient } from '../oauth/clients';
import { classifyFailure, failureResponse, oauthError } from '../oauth/errors';
import { readForm } from '../oauth/params';
import { firstPartyProof, replayedDpopProof } from '../oauth/proof';
import { grantError, required } from '../oauth/token-endpoint';
import { jsonResponse } from '../responses';
import {
  grantIdOfFirstPartyRefreshToken,
  isRandomCredential,
  randomCredential,
  sha256,
} from '../token/credentials';
import type { TicketAccess } from './store';

/**
 * One-time tickets (design 5.3): an opaque value for one audience, 60 seconds, consumed by its
 * first redemption. A browser that holds no token opens a stream, terminal, preview, dispatch or
 * download with a ticket that its backend minted.
 *
 * * `POST /tickets` mints one from the caller's first-party refresh grant with a DPoP proof for
 *   this URL, as a refresh does (design 5.4): one statement checks the grant and the key, records
 *   the proof's `jti`, stores the ticket's hash and writes the audit row. `resource` names the
 *   audience (RFC 8707 form), which must be one the grant's scopes name.
 * * Redemption is the audience's call through the `TicketRedeemer` entrypoint
 *   (src/tickets/redeemer.ts), never over the internet: only a listed caller may redeem, and only
 *   for its own audiences. One statement consumes the ticket and writes the audit row, and answers
 *   the account, grant and client it was minted for. Every ticket it cannot redeem answers the
 *   same `invalid_ticket`, so a caller learns nothing more.
 */

export type TicketDeps = { config: UtsConfig; tickets: TicketAccess };

function ticketsUrl(config: UtsConfig): string {
  return `${config.endpoints.issuer}${UTS_TICKETS_PATH}`;
}

export async function handleTicketIssue(request: Request, deps: TicketDeps): Promise<Response> {
  if (request.method !== 'POST') {
    return oauthError('invalid_request', 405, 'use POST', { Allow: 'POST' });
  }
  const form = await readForm(request);
  if (form.status === 'invalid') return oauthError('invalid_request', 400, form.description);
  const { params } = form;
  const client = requestFirstPartyClient(params);
  if (client instanceof Response) return client;
  const token = required(params, 'refresh_token');
  if (token instanceof Response) return token;
  const purposeParam = required(params, 'purpose');
  if (purposeParam instanceof Response) return purposeParam;
  const purpose = UtsTicketPurposeSchema.safeParse(purposeParam);
  if (!purpose.success)
    return oauthError('invalid_request', 400, 'purpose is not a ticket purpose');
  const resourceParam = required(params, 'resource');
  if (resourceParam instanceof Response) return resourceParam;
  const audience = audienceOfResource(resourceParam, deps.config.environment);
  if (audience === null) return grantError('invalid_target');
  const resourceId = params.one('resource_id');
  if (resourceId.status === 'repeated')
    return oauthError('invalid_request', 400, 'resource_id repeats');
  const ticketResource =
    resourceId.status === 'present' ? UtsTicketResourceSchema.safeParse(resourceId.value) : null;
  if (ticketResource !== null && !ticketResource.success) {
    return oauthError('invalid_request', 400, 'resource_id is malformed');
  }
  const grantId = grantIdOfFirstPartyRefreshToken(token);
  if (grantId === null) return grantError('invalid_grant');
  const proof = await firstPartyProof(request, ticketsUrl(deps.config));
  if (proof instanceof Response) return proof;

  const ticket = randomCredential();
  try {
    const result = await deps.tickets(async store =>
      store.issue({
        environment: deps.config.environment,
        tokenHash: await sha256(token),
        grantId,
        clientId: client.clientId,
        proof,
        ticketHash: await sha256(ticket),
        purpose: purpose.data,
        audience,
        resource: ticketResource?.data ?? null,
      })
    );
    if (result.outcome === 'dpop_replay') return replayedDpopProof();
    if (result.outcome !== 'issued') return grantError(result.outcome);
    const body: TicketResponse = {
      ticket,
      expires_in: UTS_TICKET_LIFETIME_SECONDS,
      purpose: purpose.data,
      audience,
    };
    return jsonResponse(body, 200, { Pragma: 'no-cache' });
  } catch (error) {
    return failureResponse(error, 'tickets');
  }
}

/**
 * The services that may redeem tickets, by the deployed name their service binding carries as
 * `props.caller`, with the audiences each may redeem for. A ticket opens one service, so a caller
 * redeems only tickets minted for its own audiences. Production and staging list no caller yet:
 * every redemption there is refused until a surface that takes tickets moves to UTS (phase 4) and
 * adds itself here; `test/repo` keeps every other config from binding the redeemer.
 */
export const TICKET_REDEEMERS: Readonly<
  Record<UtsEnvironment, Readonly<Record<string, readonly string[]>>>
> = {
  production: {},
  staging: {},
  development: { 'uts-ticket-test': ['gateway', 'kilo-chat', 'event-service'] },
};

/**
 * `refused`: the caller is not a listed redeemer, or the audience is not one of its own; no
 * statement runs. `invalid_ticket`: unknown, used, expired, minted for another audience, or its
 * grant ended; every such ticket answers alike. `unavailable` and `failed`: a store failure that
 * a retry can, or cannot, fix.
 */
export type TicketRedeemResult =
  | { status: 'redeemed'; redemption: TicketRedemption }
  | { status: 'refused' | 'invalid_ticket' | 'unavailable' | 'failed' };

/** Redeems `ticket` for `audience` on behalf of the binding caller `caller` (null: no props). */
export async function redeemTicket(
  deps: TicketDeps,
  caller: string | null,
  ticket: unknown,
  audience: unknown
): Promise<TicketRedeemResult> {
  const allowed = caller === null ? undefined : TICKET_REDEEMERS[deps.config.environment][caller];
  const parsedAudience = UtsAudienceSchema.safeParse(audience);
  if (allowed === undefined || !parsedAudience.success || !allowed.includes(parsedAudience.data)) {
    console.error(JSON.stringify({ event: 'uts.tickets.redeem_refused', caller }));
    return { status: 'refused' };
  }
  if (typeof ticket !== 'string' || !isRandomCredential(ticket))
    return { status: 'invalid_ticket' };
  try {
    const ticketHash = await sha256(ticket);
    const result = await deps.tickets(store =>
      store.redeem(deps.config.environment, ticketHash, parsedAudience.data)
    );
    if (result.outcome !== 'redeemed') return { status: 'invalid_ticket' };
    return {
      status: 'redeemed',
      redemption: {
        sub: result.accountId,
        sid: result.grantId,
        client_id: result.clientId,
        purpose: result.purpose,
        audience: parsedAudience.data,
        ...(result.resource === null ? {} : { resource: result.resource }),
        ...(result.orgId === null ? {} : { org: result.orgId }),
      },
    };
  } catch (error) {
    return {
      status: classifyFailure(error, 'tickets_redeem') === 'retryable' ? 'unavailable' : 'failed',
    };
  }
}
