import {
  THIRD_PARTY_CLIENTS,
  UTS_ACCESS_TOKEN_TYPE,
  UTS_ACCOUNT_AUDIENCE,
  UtsAccessTokenClaimsSchema,
  UtsTokenKidSchema,
  type SignerKeysRead,
  type UtsPublicJwk,
  utsScopeEntry,
} from '@kilocode/uts-contracts';
import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import type { Env, UtsConfig } from '../env';
import { PAT_PREFIX } from '../pat/format';
import { identifyClient } from '../oauth/clients';
import { readKeySetShard, readThroughIsolateShard } from '../signer-keys';

/**
 * The account API's check of a UTS access token (design 7, the rows that apply to a UTS token
 * verified by UTS itself): `EdDSA` with a `uts-token-` key of the signer objects, `typ` `at+jwt`,
 * the environment's issuer, the `uts` audience, time with 60 seconds of skew, the claim profile of
 * `UtsAccessTokenClaimsSchema`, the route's one scope, and a client that the scope registry allows
 * for that scope. `/authorize` and `/token` do not apply the registry yet, so this check is what
 * keeps a token of another client off the account API. Every account route acts on a session, so
 * its scope is registered with `requiresSession`, and the token must name its session (`sid`): a
 * CLI grant, or the browser session of a `kilo-web` token; a PAT names none and is refused.
 * Revocation needs no feed here: every account statement reads that session for the token's
 * subject, so an ended session, or one of another account, fails there.
 */

const SKEW_SECONDS = 60;
/** RFC 6750 section 2.1: `Bearer` and a b64token. */
const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/;

export type KeyLookup =
  | { status: 'found'; key: UtsPublicJwk }
  | { status: 'unknown' }
  | { status: 'unavailable' };

/** The public key with `kid`, from the signer keys a key-set shard holds. */
export type AccessTokenKeys = (kid: string) => Promise<KeyLookup>;

export type AccountCaller = {
  /** The token's `sub`: the only account the call can act for. */
  accountId: string;
  /** The token's `sid`: a CLI grant id, or a browser session id for `kilo-web`. */
  grantId: string;
  /** The organization the token is bound to, when it is. */
  orgId: string | null;
};

export type BearerCheck =
  | { status: 'ok'; caller: AccountCaller }
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'insufficient_scope' }
  /** The scope registry does not allow the token's client for the route's scope. */
  | { status: 'client_not_allowed' }
  | { status: 'unavailable' };

/**
 * A signer key list the isolate read is reused for this long for a `kid` it holds. A signer
 * publishes its next key long before it signs with it (design 5.7); a `kid` the copy lacks reads
 * again once the copy is 2 seconds old (`ACCESS_TOKEN_KEYS_RECHECK_MS`).
 */
export const ACCESS_TOKEN_KEYS_FRESH_MS = 10 * 1000;

/**
 * A `kid` missing from the copy reads the key set again only once the copy is this old, as old as
 * the key-set shard's own copy, so tokens under made-up kids cost at most one Durable Object call
 * per isolate per 2 seconds.
 */
export const ACCESS_TOKEN_KEYS_RECHECK_MS = 2 * 1000;

/**
 * The isolate's copy of the signer keys of one environment, as plain data: no promise is shared
 * between requests (design 7), so requests that miss at once each read, and a read that lands
 * late never replaces a newer copy.
 */
export type AccessTokenKeyCopy = {
  copy: { environment: UtsConfig['environment']; keys: UtsPublicJwk[]; readAt: number } | null;
};

const ISOLATE_KEY_COPY: AccessTokenKeyCopy = { copy: null };

/** One read of the signer keys a key-set shard holds. */
export type KeySetRead = () => Promise<SignerKeysRead>;

/**
 * The key with `kid` from the key-set shard this isolate reads (the shard the `SignerKeys`
 * entrypoint uses), through the isolate's copy: an account request makes a Durable Object call
 * only when the copy is over 10 seconds old, or over 2 seconds old and lacks `kid`. The check runs
 * before the token's signature is verified, so without the copy every request with any token
 * under a well-formed kid would cost a call. A failed shard call or a refused shard is
 * `unavailable` and leaves the copy as it was.
 */
export function shardAccessTokenKeys(
  env: Env,
  config: UtsConfig,
  held: AccessTokenKeyCopy = ISOLATE_KEY_COPY,
  read: KeySetRead = () => readThroughIsolateShard(shard => readKeySetShard(env, config, shard))
): AccessTokenKeys {
  const find = (keys: readonly UtsPublicJwk[], kid: string): KeyLookup => {
    const key = keys.find(candidate => candidate.kid === kid);
    return key === undefined ? { status: 'unknown' } : { status: 'found', key };
  };
  return async kid => {
    const startedAt = Date.now();
    const copy = held.copy?.environment === config.environment ? held.copy : null;
    if (copy !== null) {
      const age = startedAt - copy.readAt;
      const found = find(copy.keys, kid);
      if (age < ACCESS_TOKEN_KEYS_FRESH_MS && found.status === 'found') return found;
      if (age < ACCESS_TOKEN_KEYS_RECHECK_MS) return found;
    }
    let result;
    try {
      result = await read();
    } catch (error) {
      console.error(JSON.stringify({ event: 'uts.account.keys_failed', error: String(error) }));
      return { status: 'unavailable' };
    }
    if (result.status !== 'answered') return { status: 'unavailable' };
    const keys = result.answer.signers.flatMap(entry => (entry.status === 'ok' ? entry.keys : []));
    if (held.copy === null || held.copy.readAt <= startedAt) {
      held.copy = { environment: config.environment, keys, readAt: startedAt };
    }
    return find(keys, kid);
  };
}

export async function checkAccountBearer(
  authorization: string | null,
  requiredScope: string,
  config: UtsConfig,
  keys: AccessTokenKeys,
  nowSeconds: number
): Promise<BearerCheck> {
  const entry = utsScopeEntry(requiredScope);
  if (entry === null || !entry.requiresSession) {
    // A route definition error, not a request error: every account statement needs the grant.
    throw new Error(`account route scope ${requiredScope} is not registered as session-bound`);
  }
  if (authorization === null) return { status: 'missing' };
  const token = BEARER.exec(authorization)?.[1];
  if (token === undefined || token.startsWith(PAT_PREFIX)) return { status: 'invalid' };

  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return { status: 'invalid' };
  }
  const kid = UtsTokenKidSchema.safeParse(header.kid);
  if (header.alg !== 'EdDSA' || header.typ !== UTS_ACCESS_TOKEN_TYPE || !kid.success) {
    return { status: 'invalid' };
  }
  const found = await keys(kid.data);
  if (found.status === 'unavailable') return { status: 'unavailable' };
  if (found.status === 'unknown') return { status: 'invalid' };

  let payload;
  try {
    const verified = await jwtVerify(token, await importJWK(found.key, 'EdDSA'), {
      algorithms: ['EdDSA'],
      typ: UTS_ACCESS_TOKEN_TYPE,
      issuer: config.endpoints.issuer,
      audience: UTS_ACCOUNT_AUDIENCE,
      clockTolerance: SKEW_SECONDS,
      currentDate: new Date(nowSeconds * 1000),
    });
    payload = verified.payload;
  } catch {
    return { status: 'invalid' };
  }
  const claims = UtsAccessTokenClaimsSchema.safeParse(payload);
  if (
    !claims.success ||
    claims.data.env !== config.environment ||
    claims.data.iat > nowSeconds + SKEW_SECONDS
  ) {
    return { status: 'invalid' };
  }
  // The scope requires a session (checked above), and a token names its session by `sid`.
  const grantId = claims.data.sid;
  if (grantId === undefined) return { status: 'invalid' };
  if (claims.data.scope !== requiredScope) return { status: 'insufficient_scope' };
  const clientId = claims.data.client_id;
  if (
    !entry.allowedClients.includes(clientId) &&
    !(
      entry.allowedClients.includes(THIRD_PARTY_CLIENTS) &&
      identifyClient(clientId).kind === 'third_party'
    )
  ) {
    return { status: 'client_not_allowed' };
  }
  return {
    status: 'ok',
    caller: { accountId: claims.data.sub, grantId, orgId: claims.data.org ?? null },
  };
}
