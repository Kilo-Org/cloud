import jwt from 'jsonwebtoken';
import { API_GATEWAY_CREDENTIAL_FORMAT } from '@kilocode/app-shared/native-auth';

const config = { enabled: true };

jest.mock('@/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'native-access-credentials-secret',
  isNativeResourceCredentialIssuanceEnabled: () => config.enabled,
}));

import { generateNativeAccessCredentials } from './native-access-credentials';
import {
  KILO_API_AUDIENCE,
  KILO_GATEWAY_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';
import {
  isKiloCredentialExchangeEligible,
  verifyKiloTokenForPolicy,
} from '@kilocode/worker-utils/kilo-token-policy';
import type { User } from '@kilocode/db/schema';

const user = {
  id: 'native-user',
  api_token_pepper: null,
} as User;

describe('generateNativeAccessCredentials', () => {
  beforeEach(() => {
    config.enabled = true;
  });

  test('issues separated API and gateway credentials sharing one-hour timestamps', async () => {
    const result = generateNativeAccessCredentials(
      user,
      'device-session',
      API_GATEWAY_CREDENTIAL_FORMAT
    );
    expect(result.metadata).toBeDefined();
    if (!result.metadata) return;

    const apiClaims = jwt.verify(
      result.token,
      'native-access-credentials-secret'
    ) as jwt.JwtPayload;
    const gatewayClaims = jwt.verify(
      result.metadata.gatewayToken,
      'native-access-credentials-secret'
    ) as jwt.JwtPayload;

    expect(apiClaims).toMatchObject({
      aud: KILO_API_AUDIENCE,
      tokenPurpose: 'device-access',
      credentialExchange: false,
      deviceSessionId: 'device-session',
      apiTokenPepper: null,
    });
    expect(gatewayClaims).toMatchObject({
      aud: KILO_GATEWAY_AUDIENCE,
      tokenPurpose: 'device-access',
      credentialExchange: false,
      deviceSessionId: 'device-session',
      apiTokenPepper: null,
    });
    expect(apiClaims.iat).toBe(gatewayClaims.iat);
    expect(apiClaims.exp).toBe(gatewayClaims.exp);
    expect(apiClaims.exp! - apiClaims.iat!).toBe(3600);
    expect(result.metadata.expiresAt).toBe(new Date(apiClaims.exp! * 1000).toISOString());
    await expect(
      verifyKiloTokenForPolicy(result.token, 'native-access-credentials-secret', {
        audience: KILO_API_AUDIENCE,
        mode: 'required',
      }).then(auth => isKiloCredentialExchangeEligible(auth, { legacy: 'five-year-api' }))
    ).resolves.toBe(false);
  });

  test('preserves the exact legacy credential shape when issuance is disabled or unnegotiated', () => {
    config.enabled = false;
    const disabled = generateNativeAccessCredentials(
      user,
      'device-session',
      API_GATEWAY_CREDENTIAL_FORMAT
    );
    const unnegotiated = generateNativeAccessCredentials(user, 'device-session');

    expect(disabled.metadata).toBeUndefined();
    expect(unnegotiated.metadata).toBeUndefined();
    expect(jwt.decode(disabled.token)).toMatchObject({ deviceSessionId: 'device-session' });
    expect(jwt.decode(unnegotiated.token)).toMatchObject({ deviceSessionId: 'device-session' });
  });

  test('rejects an unsupported requested format instead of silently falling back', () => {
    expect(() =>
      generateNativeAccessCredentials(user, 'device-session', 'unknown-format' as never)
    ).toThrow('Unsupported native credential format');
  });
});
