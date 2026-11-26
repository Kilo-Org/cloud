import { type DpopProof, verifyDpopProof } from './dpop';
import { invalidDpopProof, oauthError, temporarilyUnavailable } from './errors';
import type { ReplayAccess } from './replay';

/**
 * The DPoP step of a first-party request: verify the proof for `POST` at `url`, then record its
 * `jti` in the replay object of `grantId`. A refused proof, a replay, or a replay object that does
 * not answer ends the request before any identity-store statement runs.
 */
export async function firstPartyProof(
  request: Request,
  replay: ReplayAccess,
  url: string,
  grantId: string
): Promise<DpopProof | Response> {
  const check = await verifyDpopProof(request, 'POST', url, Math.floor(Date.now() / 1000));
  if (check.status === 'missing') return invalidDpopProof('a DPoP proof is required');
  if (check.status === 'invalid') {
    return invalidDpopProof(`the DPoP proof is invalid: ${check.reason}`);
  }
  const recorded = await replay(grantId, check.proof);
  if (recorded === 'replayed') return invalidDpopProof('the DPoP proof was used before');
  if (recorded === 'unavailable') return temporarilyUnavailable();
  if (recorded === 'misconfigured') return oauthError('server_error', 500);
  return check.proof;
}

/** A third-party client sends no DPoP proof: its refresh tokens rotate instead (design 5.4). */
export function refuseThirdPartyProof(request: Request): Response | null {
  return request.headers.has('DPoP')
    ? oauthError('invalid_request', 400, 'DPoP binding is available to first-party clients only')
    : null;
}
