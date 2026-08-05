import * as z from 'zod';

const tokenResponseSchema = z.object({ token: z.string().min(1) });
const tokenPairSchema = z.object({
  token: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresIn: z.number().positive().optional(),
});
const emailCodeResponseSchema = z.object({
  success: z.literal(true),
  challengeId: z.uuid().optional(),
});
const errorResponseSchema = z.object({ error: z.string() });

export type TokenPair =
  | { token: string; refreshToken: string; expiresIn: number }
  | { token: string; refreshToken?: undefined; expiresIn?: undefined };

export function parseTokenResponse(value: unknown): { token: string } | null {
  const result = tokenResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseTokenPair(value: unknown): TokenPair | null {
  const result = tokenPairSchema.safeParse(value);
  if (!result.success) {
    return null;
  }
  const { token, refreshToken, expiresIn } = result.data;
  if (refreshToken && expiresIn) {
    return { token, refreshToken, expiresIn };
  }
  return { token };
}

const deviceAuthTokenStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired']);

const deviceAuthTokenResponseSchema = z.object({
  status: deviceAuthTokenStatusSchema,
  token: z.string().min(1).optional(),
  refreshToken: z.string().min(1).optional(),
  expiresIn: z.number().positive().optional(),
});

const deviceAuthCodeResponseSchema = z.object({
  code: z.string().min(1),
  user_code: z.string().min(1).optional(),
  device_code: z.string().min(1).optional(),
  verificationUrl: z.string().min(1),
});

export type DeviceAuthTokenResult =
  | { status: 'approved'; token: string; refreshToken: string; expiresIn: number }
  | { status: 'approved'; token: string; refreshToken?: undefined; expiresIn?: undefined }
  | { status: 'pending' | 'denied' | 'expired' };

export type DeviceAuthCodeResult = {
  userCode: string;
  deviceCode: string;
  verificationUrl: string;
};

export function buildDeviceAuthPollRequest(deviceCode: string): {
  deviceCode: string;
  supportsRefresh: true;
} {
  return { deviceCode, supportsRefresh: true };
}

export function shouldRefreshBeforeRequest(
  expiresAt: number,
  now: number,
  margin: number
): boolean {
  return now >= expiresAt - margin;
}

export function parseDeviceAuthCodeResponse(value: unknown): DeviceAuthCodeResult | null {
  const result = deviceAuthCodeResponseSchema.safeParse(value);
  if (!result.success) {
    return null;
  }
  const userCode = result.data.user_code ?? result.data.code;
  const deviceCode = result.data.device_code ?? result.data.code;
  if (result.data.device_code && result.data.verificationUrl.includes(deviceCode)) {
    return null;
  }
  return { userCode, deviceCode, verificationUrl: result.data.verificationUrl };
}

export function parseDeviceAuthTokenResponse(value: unknown): DeviceAuthTokenResult | null {
  const result = deviceAuthTokenResponseSchema.safeParse(value);
  if (!result.success) {
    return null;
  }
  const { status, token, refreshToken, expiresIn } = result.data;
  if (status === 'approved' && token) {
    // Require a complete pair: both refreshToken AND expiresIn must be
    // present. An incomplete pair (one without the other) is dropped to
    // token-only so signIn never stores a refresh token with no expiry;
    // proactive refresh relies on TOKEN_EXPIRES_AT_KEY to decide rotation.
    if (refreshToken && expiresIn) {
      return { status, token, refreshToken, expiresIn };
    }
    return { status, token };
  }
  if (status !== 'approved') {
    return { status };
  }
  return null;
}

export function parseEmailCodeResponse(value: unknown) {
  const result = emailCodeResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseAuthErrorCode(value: unknown): string | undefined {
  const result = errorResponseSchema.safeParse(value);
  return result.success ? result.data.error : undefined;
}

export type ChallengeEntry = { email: string; challengeId: string };

export function buildChallengeEntry(
  parsed: NonNullable<ReturnType<typeof parseEmailCodeResponse>>,
  email: string
): ChallengeEntry | null {
  if (parsed.challengeId) {
    return { email, challengeId: parsed.challengeId };
  }
  return null;
}

export function selectChallengeId(entry: ChallengeEntry | null, email: string): string | undefined {
  return entry?.email === email ? entry.challengeId : undefined;
}
