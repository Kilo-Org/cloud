import {
  THIRD_PARTY_CLIENTS,
  UTS_ACCESS_TOKEN_TYPE,
  UTS_ACCOUNT_AUDIENCE,
  UtsAccessTokenClaimsSchema,
  UtsTokenKidSchema,
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
 * its scope is registered with `requiresSession`, and the token must name its grant (`sid`); a PAT
 * names none and is refused. Revocation needs no feed here: every account statement reads the
 * grant and its session, so a revoked grant fails there.
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
  accountId: string;
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
 * The key with `kid` from the key-set shard this isolate reads (the shard the `SignerKeys`
 * entrypoint uses), so an account request makes one Durable Object call and the shards keep their
 * bound on signer reads. A failed shard call or a refused shard is `unavailable`.
 */
export function shardAccessTokenKeys(env: Env, config: UtsConfig): AccessTokenKeys {
  return async kid => {
    let read;
    try {
      read = await readThroughIsolateShard(shard => readKeySetShard(env, config, shard));
    } catch (error) {
      console.error(JSON.stringify({ event: 'uts.account.keys_failed', error: String(error) }));
      return { status: 'unavailable' };
    }
    if (read.status !== 'answered') return { status: 'unavailable' };
    for (const entry of read.answer.signers) {
      if (entry.status !== 'ok') continue;
      const key = entry.keys.find(candidate => candidate.kid === kid);
      if (key !== undefined) return { status: 'found', key };
    }
    return { status: 'unknown' };
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
