import { z } from 'zod';
import { UtsScopeSchema } from './token';

/**
 * The RFC 8693 broker exchange at the UTS token endpoint (design 5.9). A workload that holds an
 * STS token for the audience `uts` with the scope `uts:token-exchange` presents a UTS access token
 * of its subject (`subject_token`) and receives a delegated `kilo-api` token whose `act` names the
 * workload. Kilo MCP is the one workload the exchange serves.
 */

/** RFC 8693 section 3: the token type of an access token, for the subject and the result. */
export const UTS_ACCESS_TOKEN_TYPE_URN = 'urn:ietf:params:oauth:token-type:access_token';

/** The scope of the caller's STS token (audience `uts`); phase 2 owns the workload grant. */
export const UTS_TOKEN_EXCHANGE_STS_SCOPE = 'uts:token-exchange';

/** The STS workload the exchange serves; it becomes `act.sub` and `req` of every result. */
export const UTS_TOKEN_EXCHANGE_ACTOR = 'kilo-mcp';

/** A delegated token lives at most 5 minutes and never past the subject token's own `exp`. */
export const UTS_EXCHANGED_TOKEN_MAX_LIFETIME_SECONDS = 300;

/**
 * A subject token with less than this left is refused (`invalid_grant`): the caller refreshes the
 * subject token and exchanges again.
 */
export const UTS_EXCHANGE_MIN_SUBJECT_SECONDS = 30;

/** Exchanges allowed per minute in each UTS isolate, per subject `sid` and per caller workload. */
export const UTS_EXCHANGE_LIMITS = { subject: 60, caller: 600 } as const;

/** The success answer (RFC 8693 section 2.2.1). `expires_in` is the real remaining lifetime. */
export const TokenExchangeResponseSchema = z.strictObject({
  access_token: z.string().min(1),
  issued_token_type: z.literal(UTS_ACCESS_TOKEN_TYPE_URN),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive().max(UTS_EXCHANGED_TOKEN_MAX_LIFETIME_SECONDS),
  scope: UtsScopeSchema,
});
export type TokenExchangeResponse = z.infer<typeof TokenExchangeResponseSchema>;

/**
 * The 429 answer, with `Retry-After` set to the whole seconds until the limiting window resets
 * (1 to 60). `subject`: back off only that verified `sid`. `caller`: the calling workload is over
 * its budget in this UTS isolate; pause its exchanges.
 */
export const TokenExchangeSlowDownSchema = z.strictObject({
  error: z.literal('slow_down'),
  limit: z.enum(['subject', 'caller']),
});
export type TokenExchangeSlowDown = z.infer<typeof TokenExchangeSlowDownSchema>;
