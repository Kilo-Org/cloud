import * as z from 'zod';

import { parseTimestamp } from '@kilocode/app-shared/utils';

const tokenResponseSchema = z.object({ token: z.string().min(1) });
const tokenPairSchema = z.object({
  token: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresIn: z.number().positive().optional(),
  created: z.boolean().optional(),
  // Parsed on its own below: a malformed link result must not refuse the sign-in.
  pendingLink: z.unknown().optional(),
});
const emailCodeResponseSchema = z.object({
  success: z.literal(true),
  challengeId: z.uuid().optional(),
});
const errorResponseSchema = z.object({
  error: z.string(),
  ssoOrganizationId: z.string().min(1).optional(),
  // Parsed on their own below: a malformed method list or link offer must not hide the error code.
  methods: z.unknown().optional(),
  pendingLink: z.unknown().optional(),
});
const signupMethodsSchema = z.array(z.string());

const pendingLinkOfferSchema = z.object({
  token: z.string().min(1),
  provider: z.string().min(1),
  email: z.string().min(1),
  methods: z.array(z.string().min(1)),
  emailCode: z.boolean(),
  expiresAt: z.iso.datetime({ offset: true }),
});

const PENDING_LINK_FAILURE_REASONS = [
  'EXPIRED',
  'WRONG_ACCOUNT',
  'ACCOUNT-ALREADY-LINKED',
  'PROVIDER-ALREADY-LINKED',
  'LINKING-FAILED',
] as const;

const pendingLinkResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('linked'), provider: z.string().min(1) }),
  z.object({ status: z.literal('failed'), reason: z.string().min(1) }),
]);

/**
 * A sign-in method waiting to be attached to the existing account that owns its
 * email. `token` is the secret every resolving request sends back as
 * `pendingLinkToken`; `expiresAt` is epoch milliseconds.
 */
export type PendingLinkOffer = {
  token: string;
  provider: string;
  email: string;
  methods: string[];
  emailCode: boolean;
  expiresAt: number;
};

export type PendingLinkFailureReason = (typeof PENDING_LINK_FAILURE_REASONS)[number];

/** What happened to the pending link a successful sign-in carried. */
export type PendingLinkResult =
  | { status: 'linked'; provider: string }
  | { status: 'failed'; reason: PendingLinkFailureReason };

export function parsePendingLinkOffer(value: unknown): PendingLinkOffer | undefined {
  const result = pendingLinkOfferSchema.safeParse(value);
  if (!result.success) {
    return undefined;
  }
  const expiresAt = parseTimestamp(result.data.expiresAt).getTime();
  if (Number.isNaN(expiresAt)) {
    return undefined;
  }
  return { ...result.data, expiresAt };
}

export function parsePendingLinkResult(value: unknown): PendingLinkResult | undefined {
  const result = pendingLinkResultSchema.safeParse(value);
  if (!result.success) {
    return undefined;
  }
  const parsed = result.data;
  if (parsed.status === 'linked') {
    return parsed;
  }
  // A reason this build does not know still tells the person the link did not happen.
  const reason = PENDING_LINK_FAILURE_REASONS.find(known => known === parsed.reason);
  return { status: 'failed', reason: reason ?? 'LINKING-FAILED' };
}

type TokenPairExtras = { created?: boolean; pendingLink?: PendingLinkResult };

export type TokenPair =
  | ({ token: string; refreshToken: string; expiresIn: number } & TokenPairExtras)
  | ({ token: string; refreshToken?: undefined; expiresIn?: undefined } & TokenPairExtras);

/** `{ pendingLink }` when present, so callers spread it without adding an undefined key. */
function pendingLinkField(value: unknown): { pendingLink?: PendingLinkResult } {
  const pendingLink = parsePendingLinkResult(value);
  return pendingLink ? { pendingLink } : {};
}

export function parseTokenResponse(value: unknown): { token: string } | null {
  const result = tokenResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseTokenPair(value: unknown): TokenPair | null {
  const result = tokenPairSchema.safeParse(value);
  if (!result.success) {
    return null;
  }
  const { token, refreshToken, expiresIn, created } = result.data;
  const extras = pendingLinkField(result.data.pendingLink);
  if (refreshToken && expiresIn) {
    return { token, refreshToken, expiresIn, created, ...extras };
  }
  return { token, created, ...extras };
}

const deviceAuthTokenStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired']);

const deviceAuthTokenResponseSchema = z.object({
  status: deviceAuthTokenStatusSchema,
  token: z.string().min(1).optional(),
  refreshToken: z.string().min(1).optional(),
  expiresIn: z.number().positive().optional(),
  pendingLink: z.unknown().optional(),
});

const deviceAuthCodeResponseSchema = z.object({
  code: z.string().min(1),
  user_code: z.string().min(1).optional(),
  device_code: z.string().min(1).optional(),
  verificationUrl: z.string().min(1),
});

export type DeviceAuthTokenResult =
  | {
      status: 'approved';
      token: string;
      refreshToken: string;
      expiresIn: number;
      pendingLink?: PendingLinkResult;
    }
  | {
      status: 'approved';
      token: string;
      refreshToken?: undefined;
      expiresIn?: undefined;
      pendingLink?: PendingLinkResult;
    }
  | { status: 'pending' | 'denied' | 'expired' };

export type DeviceAuthCodeResult = {
  userCode: string;
  deviceCode: string;
  verificationUrl: string;
};

export function buildDeviceAuthPollRequest(deviceCode: string) {
  return { deviceCode, supportsRefresh: true as const };
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
    const extras = pendingLinkField(result.data.pendingLink);
    // Require a complete pair: both refreshToken AND expiresIn must be
    // present. An incomplete pair (one without the other) is dropped to
    // token-only so signIn never stores a refresh token with no expiry;
    // proactive refresh relies on TOKEN_EXPIRES_AT_KEY to decide rotation.
    if (refreshToken && expiresIn) {
      return { status, token, refreshToken, expiresIn, ...extras };
    }
    return { status, token, ...extras };
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

export function parseAuthError(value: unknown):
  | {
      code: string;
      ssoOrganizationId?: string;
      signupMethods?: string[];
      pendingLink?: PendingLinkOffer;
    }
  | undefined {
  const result = errorResponseSchema.safeParse(value);
  if (!result.success) {
    return undefined;
  }
  const methods = signupMethodsSchema.safeParse(result.data.methods);
  const pendingLink = parsePendingLinkOffer(result.data.pendingLink);
  return {
    code: result.data.error,
    ssoOrganizationId: result.data.ssoOrganizationId,
    signupMethods: methods.success ? methods.data : undefined,
    ...(pendingLink ? { pendingLink } : {}),
  };
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
