import {
  type DeviceAuthorizationResponse,
  UTS_DEVICE_VERIFICATION_PATH,
  UTS_MAX_TOKENS_PER_CALL,
} from '@kilocode/uts-contracts';
import { requestFirstPartyClient } from '../../oauth/clients';
import { failureResponse, oauthError } from '../../oauth/errors';
import { parseScopes, readForm } from '../../oauth/params';
import { jsonResponse } from '../../responses';
import { randomCredential, sha256 } from '../../token/credentials';
import type { SignInDeps } from '../deps';
import { requestNetwork } from '../network';
import { formatUserCode, importUserCodeKey, newUserCode, userCodeHash } from './user-code';

/** The device grant's dependencies: the sign-in store and the user-code secret. */
export type DeviceDeps = SignInDeps & { userCodeSecret: string };

/** A new user code collides with a live one about once in 2^34 draws; three draws suffice. */
const USER_CODE_DRAWS = 3;

/**
 * POST /device_authorization (RFC 8628 section 3.1) for a first-party client that may use the
 * device grant (the CLI's fallback, design 5.5). It stores a 10-minute device code, of which the
 * identity store keeps only hashes, and answers the codes and the verification page.
 */
export async function handleDeviceAuthorization(
  request: Request,
  deps: DeviceDeps
): Promise<Response> {
  if (request.method !== 'POST') {
    return oauthError('invalid_request', 405, 'use POST', { Allow: 'POST' });
  }
  const form = await readForm(request);
  if (form.status === 'invalid') return oauthError('invalid_request', 400, form.description);
  const client = requestFirstPartyClient(form.params);
  if (client instanceof Response) return client;
  if (!client.deviceGrant) {
    return oauthError('unauthorized_client', 400, 'this client does not use the device grant');
  }
  const scopeParam = form.params.one('scope');
  const requested =
    scopeParam.status === 'present' ? parseScopes(scopeParam.value, UTS_MAX_TOKENS_PER_CALL) : null;
  if (requested === null) {
    return oauthError('invalid_scope', 400, 'scope must name 1 to 8 UTS scopes once each');
  }
  const scopes = [...requested].sort();

  const deviceCode = randomCredential();
  const network = requestNetwork(request);
  try {
    const key = await importUserCodeKey(deps.userCodeSecret);
    const deviceCodeHash = await sha256(deviceCode);
    for (let draw = 0; draw < USER_CODE_DRAWS; draw++) {
      const userCode = newUserCode();
      const created = await deps.signIn(async store =>
        store.createDeviceCode({
          deviceCodeHash,
          userCodeHash: await userCodeHash(key, userCode),
          clientId: client.clientId,
          scopes,
          network,
        })
      );
      if (created.outcome === 'user_code_taken') continue;
      const verification = `${deps.config.endpoints.issuer}${UTS_DEVICE_VERIFICATION_PATH}`;
      const body: DeviceAuthorizationResponse = {
        device_code: deviceCode,
        user_code: formatUserCode(userCode),
        verification_uri: verification,
        verification_uri_complete: `${verification}?user_code=${formatUserCode(userCode)}`,
        expires_in: Math.max(1, Math.floor((created.expiresAt.getTime() - Date.now()) / 1000)),
        interval: created.interval,
      };
      return jsonResponse(body, 200, { Pragma: 'no-cache' });
    }
    return oauthError('temporarily_unavailable', 503, undefined, { 'Retry-After': '2' });
  } catch (error) {
    return failureResponse(error, 'device_authorization');
  }
}
