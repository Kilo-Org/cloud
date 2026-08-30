import { signKiloToken } from '@kilocode/worker-utils';

type TokenUser = {
  id: string;
  api_token_pepper: string | null;
};

const ONE_HOUR_SECONDS = 60 * 60;

export async function generateInternalServiceToken(
  userId: string,
  secret: string
): Promise<string> {
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

export async function generateApiToken(
  user: TokenUser,
  secret: string,
  environment: string
): Promise<string> {
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
