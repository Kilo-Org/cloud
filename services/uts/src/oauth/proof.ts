import { type DpopProof, verifyDpopProof } from './dpop';
import { invalidDpopProof, oauthError } from './errors';

/**
 * The DPoP step of a first-party request: verify the proof for `POST` at `url`. A refused proof
 * ends the request before any identity-store statement runs; the grant statement records the
 * proof's `jti`, so a replayed proof fails there (`replayedDpopProof`).
 */
export async function firstPartyProof(
  request: Request,
  url: string
): Promise<DpopProof | Response> {
  const check = await verifyDpopProof(request, 'POST', url, Math.floor(Date.now() / 1000));
  if (check.status === 'missing') return invalidDpopProof('a DPoP proof is required');
  if (check.status === 'invalid') {
    return invalidDpopProof(`the DPoP proof is invalid: ${check.reason}`);
  }
  return check.proof;
}

/** The answer when the grant statement found the proof's `jti` recorded already. */
export function replayedDpopProof(): Response {
  return invalidDpopProof('the DPoP proof was used before');
}

/** A third-party client sends no DPoP proof: its refresh tokens rotate instead (design 5.4). */
export function refuseThirdPartyProof(request: Request): Response | null {
  return request.headers.has('DPoP')
    ? oauthError('invalid_request', 400, 'DPoP binding is available to first-party clients only')
    : null;
}
