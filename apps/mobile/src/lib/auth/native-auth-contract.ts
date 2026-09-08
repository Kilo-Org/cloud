import * as z from 'zod';
import {
  API_GATEWAY_CREDENTIAL_FORMAT,
  type NativeCredentialBundleMetadata,
  type NativeTokenPair,
  parseNativeTokenPair,
} from '@kilocode/app-shared/native-auth';

const tokenResponseSchema = z.object({ token: z.string().min(1) });
const credentialEnvelopeSchema = z.record(z.string(), z.unknown());
const emailCodeResponseSchema = z.object({
  success: z.literal(true),
  challengeId: z.uuid().optional(),
});
const errorResponseSchema = z.object({
  error: z.string(),
  ssoOrganizationId: z.string().min(1).optional(),
});

export type TokenPair = NativeTokenPair;

export function parseTokenResponse(value: unknown): { token: string } | null {
  if (hasCredentialFormat(value)) {
    return null;
  }
  const result = tokenResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseTokenPair(value: unknown): TokenPair | null {
  return parseNativeTokenPair(value);
}

export { API_GATEWAY_CREDENTIAL_FORMAT, type NativeCredentialBundleMetadata, type NativeTokenPair };

function hasCredentialFormat(value: unknown): boolean {
  const envelope = credentialEnvelopeSchema.safeParse(value);
  return (
    envelope.success &&
    (Object.hasOwn(envelope.data, 'credentialFormat') ||
      Object.hasOwn(envelope.data, 'gatewayToken') ||
      Object.hasOwn(envelope.data, 'metadata'))
  );
}

const deviceAuthTokenStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired']);

const deviceAuthTokenResponseSchema = z.looseObject({
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
  | ({ status: 'approved' } & NativeTokenPair)
  | { status: 'pending' | 'denied' | 'expired' };

export type DeviceAuthCodeResult = {
  userCode: string;
  deviceCode: string;
  verificationUrl: string;
};

export function buildDeviceAuthPollRequest(deviceCode: string) {
  return {
    deviceCode,
    credentialFormat: API_GATEWAY_CREDENTIAL_FORMAT,
    supportsRefresh: true as const,
  };
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
  const { status, ...pairValue } = result.data;
  if (status === 'approved') {
    const pair = parseNativeTokenPair(pairValue);
    return pair ? { status, ...pair } : null;
  }
  return { status };
}

export function parseEmailCodeResponse(value: unknown) {
  const result = emailCodeResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseAuthError(
  value: unknown
): { code: string; ssoOrganizationId?: string } | undefined {
  const result = errorResponseSchema.safeParse(value);
  if (!result.success) {
    return undefined;
  }
  return { code: result.data.error, ssoOrganizationId: result.data.ssoOrganizationId };
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
