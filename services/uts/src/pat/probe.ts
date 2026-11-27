import {
  type PatProbeResponse,
  UTS_ACCOUNT_AUDIENCE,
  UTS_PROBE_READ_SCOPE,
  type UtsPatLookupResult,
} from '@kilocode/uts-contracts';
import {
  accountError,
  credentialInvalid,
  credentialMissing,
  dependencyUnavailable,
  insufficientScope,
  methodNotAllowed,
} from '../account/responses';
import type { UtsConfig } from '../env';
import { jsonResponse } from '../responses';
import { clientLimitKey } from '../network-address';
import { type AddressWindows, admitLookup } from './address-limit';
import { hexOfHash, isWellFormedSecret, secretHash } from './format';

/**
 * GET /probe/pat: a route that UTS itself verifies with a PAT, so a PAT can be proven end to end
 * (create, use, revoke) before any service accepts PATs. It follows the verifier rules for a PAT
 * (design 7): the offline format and checksum check first, so a malformed value gets 401 without a
 * lookup; a client address is required; at most 20 lookups per second per client (an IPv4 address
 * or an IPv6 /64) per isolate;
 * then the UTS lookup, with no cache, so a revoked PAT fails on its next use. It accepts only a
 * PAT for the `uts` audience with the scope `uts:probe.read`, and answers whose PAT it is.
 */

export type PatProbeDeps = {
  config: UtsConfig;
  lookup: (hash: string) => Promise<UtsPatLookupResult>;
  windows: AddressWindows;
  now: () => number;
};

const BEARER = /^Bearer (\S+)$/;

export async function handlePatProbe(request: Request, deps: PatProbeDeps): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const authorization = request.headers.get('Authorization');
  if (authorization === null) return credentialMissing(deps.config);
  const pat = BEARER.exec(authorization)?.[1];
  if (pat === undefined || !isWellFormedSecret('pat', pat)) {
    return credentialInvalid(deps.config, 'the credential is not a well-formed PAT');
  }
  // The address the Cloudflare edge saw; a client cannot set it. Lookups count per IPv4 address
  // or IPv6 /64.
  const client = clientLimitKey(request.headers.get('CF-Connecting-IP'));
  if (client === null) {
    return accountError('invalid_request', 400, 'the request carries no client address');
  }
  if (!admitLookup(deps.windows, client, deps.now())) {
    return accountError('too_many_requests', 429, 'too many PAT lookups from this address', {
      'Retry-After': '1',
    });
  }

  const result = await deps.lookup(hexOfHash(await secretHash(pat)));
  switch (result.status) {
    case 'not_found':
      return credentialInvalid(deps.config, 'the PAT is unknown, revoked or expired');
    case 'rate_limited':
    case 'unavailable':
      return dependencyUnavailable(result.retryAfterSeconds);
    case 'found': {
      const { record } = result;
      if (record.audience !== UTS_ACCOUNT_AUDIENCE || record.scope !== UTS_PROBE_READ_SCOPE) {
        return insufficientScope(deps.config, UTS_PROBE_READ_SCOPE);
      }
      const body: PatProbeResponse = {
        sub: record.subject,
        pat_id: record.patId,
        audience: record.audience,
        scope: record.scope,
        org: record.org,
      };
      return jsonResponse(body, 200);
    }
  }
}
