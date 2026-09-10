import 'server-only';
import {
  API_GATEWAY_CREDENTIAL_FORMAT,
  nativeCredentialFormatSchema,
  type NativeAccessCredentials,
  type NativeCredentialFormat,
} from '@kilocode/app-shared/native-auth';
import type { User } from '@kilocode/db/schema';
import {
  KILO_API_AUDIENCE,
  KILO_GATEWAY_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';
import { buildModernKiloTokenPayload } from '@kilocode/worker-utils/kilo-token-policy';
import jwt from 'jsonwebtoken';
import { isNativeResourceCredentialIssuanceEnabled, NEXTAUTH_SECRET } from '@/lib/config.server';
import { generateApiToken, TOKEN_EXPIRY } from '@/lib/tokens';

const jwtSigningAlgorithm = 'HS256';

export function generateNativeAccessCredentials(
  user: User,
  deviceSessionId: string,
  credentialFormat?: NativeCredentialFormat
): NativeAccessCredentials {
  if (
    credentialFormat !== undefined &&
    !nativeCredentialFormatSchema.safeParse(credentialFormat).success
  ) {
    throw new Error('Unsupported native credential format');
  }

  if (
    credentialFormat !== API_GATEWAY_CREDENTIAL_FORMAT ||
    !isNativeResourceCredentialIssuanceEnabled()
  ) {
    return {
      token: generateApiToken(user, { deviceSessionId }, { expiresIn: TOKEN_EXPIRY.oneHour }),
    };
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + TOKEN_EXPIRY.oneHour;
  const payload = (audience: string) =>
    buildModernKiloTokenPayload({
      userId: user.id,
      pepper: user.api_token_pepper,
      env: process.env.NODE_ENV,
      audience,
      issuedAt,
      expiresAt,
      tokenPurpose: 'device-access',
      credentialExchange: false,
      extra: { deviceSessionId },
    });

  return {
    token: jwt.sign(payload(KILO_API_AUDIENCE), NEXTAUTH_SECRET, {
      algorithm: jwtSigningAlgorithm,
    }),
    metadata: {
      credentialFormat,
      gatewayToken: jwt.sign(payload(KILO_GATEWAY_AUDIENCE), NEXTAUTH_SECRET, {
        algorithm: jwtSigningAlgorithm,
      }),
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    },
  };
}
