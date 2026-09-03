import { signKiloToken } from '@kilocode/worker-utils';
import { signModernKiloToken } from '@kilocode/worker-utils/kilo-token-policy';
import {
  CLOUD_AGENT_NEXT_AUDIENCE,
  KILO_GATEWAY_AUDIENCE,
  SESSION_INGEST_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';

type TokenUser = {
  id: string;
  api_token_pepper: string | null;
};

const ONE_HOUR_SECONDS = 60 * 60;

export function isSharedResourceTokensEnabled(value: string | boolean | undefined): boolean {
  return value === true || value === 'true';
}

export async function generateInternalServiceToken(
  userId: string,
  secret: string,
  sharedResourceTokensEnabled: string | boolean | undefined
): Promise<string> {
  if (isSharedResourceTokensEnabled(sharedResourceTokensEnabled)) {
    const { token } = await signModernKiloToken({
      userId,
      secret,
      expiresInSeconds: ONE_HOUR_SECONDS,
      audience: SESSION_INGEST_AUDIENCE,
      tokenPurpose: 'internal-service',
      credentialExchange: false,
    });
    return token;
  }

  // No `pepper` field: verifiers treat an absent apiTokenPepper claim as
  // "skip pepper comparison" for internal-service tokens (see
  // verifyKiloBearerAgainstCurrentPepper in @kilocode/worker-utils).
  const { token } = await signKiloToken({
    userId,
    secret,
    expiresInSeconds: ONE_HOUR_SECONDS,
  });
  return token;
}

export async function generateControlToken(
  user: TokenUser,
  secret: string,
  environment: string,
  sharedResourceTokensEnabled: string | boolean | undefined,
  organizationId?: string
): Promise<string> {
  if (isSharedResourceTokensEnabled(sharedResourceTokensEnabled)) {
    const { token } = await signModernKiloToken({
      userId: user.id,
      pepper: user.api_token_pepper,
      secret,
      expiresInSeconds: ONE_HOUR_SECONDS,
      env: environment,
      audience: CLOUD_AGENT_NEXT_AUDIENCE,
      tokenPurpose: 'internal-service',
      credentialExchange: false,
      extra: {
        internalApiUse: true,
        createdOnPlatform: 'security-agent',
        organizationId,
        runtimeAdmission: {
          source: 'automation',
          authorizationUserId: user.id,
          authorizationPepper: user.api_token_pepper,
        },
      },
    });
    return token;
  }

  const { token } = await signKiloToken({
    userId: user.id,
    pepper: user.api_token_pepper,
    secret,
    expiresInSeconds: ONE_HOUR_SECONDS,
    env: environment,
    extra: {
      internalApiUse: true,
      createdOnPlatform: 'security-agent',
    },
  });
  return token;
}

export async function generateTriageToken(
  user: TokenUser,
  secret: string,
  environment: string,
  sharedResourceTokensEnabled: string | boolean | undefined
): Promise<string> {
  if (!isSharedResourceTokensEnabled(sharedResourceTokensEnabled)) {
    return generateControlToken(user, secret, environment, false);
  }

  const { token } = await signModernKiloToken({
    userId: user.id,
    pepper: user.api_token_pepper,
    secret,
    expiresInSeconds: ONE_HOUR_SECONDS,
    env: environment,
    audience: KILO_GATEWAY_AUDIENCE,
    tokenPurpose: 'internal-service',
    credentialExchange: false,
    extra: {
      internalApiUse: true,
      createdOnPlatform: 'security-agent',
    },
  });
  return token;
}
