import { requestFirstPartyClient } from '../../oauth/clients';
import { oauthError } from '../../oauth/errors';
import type { Params } from '../../oauth/params';
import { firstPartyProof, replayedDpopProof } from '../../oauth/proof';
import {
  type DeviceCodeGrant,
  type TokenDeps,
  completeMint,
  deviceContext,
  grantError,
  required,
  tokenEndpointUrl,
  tokenSelection,
} from '../../oauth/token-endpoint';
import type { MintClient } from '../../scopes/policy';
import {
  firstPartyRefreshToken,
  grantIdOfCode,
  isRandomCredential,
  randomCredential,
  sha256,
} from '../../token/credentials';
import type { SignInAccess } from '../store';

/** RFC 8628 section 3.5: the answers of a poll before the user decided. */
const PENDING_ERRORS = {
  authorization_pending: 'the user has not approved the device yet',
  slow_down: 'poll less often: the interval grew by 5 seconds',
  access_denied: 'the user denied the device',
  expired_token: 'the device code expired; start again',
} as const;

/**
 * POST /token with `urn:ietf:params:oauth:grant-type:device_code` (RFC 8628 section 3.4) for a
 * first-party client that may use the device grant. Like a first-party code exchange (design 5.4):
 * the request carries a DPoP proof, one statement consumes the approved code, records the proof's
 * `jti` under the new grant (its id comes from the device code) and creates the device session and
 * the DPoP-bound refresh grant with their audit row, and the tokens are signed in one call to the
 * grant's signer object. A retry after a failed signing gets the same grant with a new refresh
 * token while the device code's 10 minutes last.
 */
export function deviceCodeGrant(
  tokenDeps: Pick<TokenDeps, 'config' | 'sign' | 'scopes'>,
  signIn: SignInAccess
): DeviceCodeGrant {
  return async (request: Request, params: Params): Promise<Response> => {
    const client = requestFirstPartyClient(params);
    if (client instanceof Response) return client;
    if (!client.deviceGrant) {
      return oauthError('unauthorized_client', 400, 'this client does not use the device grant');
    }
    const deviceCode = required(params, 'device_code');
    if (deviceCode instanceof Response) return deviceCode;
    const mintClient: MintClient = { kind: 'first_party', clientId: client.clientId };
    const selection = tokenSelection(params, tokenDeps, mintClient);
    if (selection instanceof Response) return selection;
    const device = deviceContext(request, params, client);
    if (device instanceof Response) return device;
    if (!isRandomCredential(deviceCode)) return grantError('invalid_grant');
    const proof = await firstPartyProof(request, tokenEndpointUrl(tokenDeps.config));
    if (proof instanceof Response) return proof;

    const grantId = await grantIdOfCode(deviceCode);
    const refreshToken = firstPartyRefreshToken(grantId, randomCredential());
    const result = await signIn(async store =>
      store.exchangeDeviceCode({
        environment: tokenDeps.config.environment,
        deviceCodeHash: await sha256(deviceCode),
        clientId: client.clientId,
        clientClass: client.clientClass,
        proof,
        grantId,
        refreshTokenHash: await sha256(refreshToken),
        device,
        ...selection,
      })
    );
    switch (result.outcome) {
      case 'issued':
        // `uts.exchange_device_code` binds no organization, so the subject holds no role to check.
        return await completeMint(
          tokenDeps,
          mintClient,
          grantId,
          { ...result, orgRole: null },
          {
            token: refreshToken,
            expiresAt: result.refreshExpiresAt,
          }
        );
      case 'authorization_pending':
      case 'slow_down':
      case 'access_denied':
      case 'expired_token':
        return oauthError(result.outcome, 400, PENDING_ERRORS[result.outcome]);
      case 'dpop_replay':
        return replayedDpopProof();
      default:
        return grantError(result.outcome);
    }
  };
}
