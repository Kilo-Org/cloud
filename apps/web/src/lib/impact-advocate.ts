import 'server-only';

import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import type { User } from '@kilocode/db/schema';
import {
  IMPACT_ACCOUNT_SID,
  IMPACT_ADVOCATE_ACCOUNT_SID,
  IMPACT_ADVOCATE_API_BASE_URL,
  IMPACT_ADVOCATE_AUTH_TOKEN,
  IMPACT_ADVOCATE_PROGRAM_ID,
  IMPACT_ADVOCATE_TENANT_ALIAS,
  IMPACT_ADVOCATE_WIDGET_ID,
} from '@/lib/config.server';
import { logImpactReferralDebug, truncateForLog } from '@/lib/impact-debug';

/**
 * SaaSquatch / Impact Advocate expects locale tags formatted as `en_US`,
 * not the BCP 47 `en-US` we get from Accept-Language. Normalize once here
 * so the value is consistent both on the wire and in the persisted payload.
 */
function normalizeAdvocateLocale(locale: string | null | undefined): string | null {
  const trimmed = locale?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/-/g, '_');
}

export const IMPACT_ADVOCATE_DEFAULT_PROGRAM_ID = '51699';
export const IMPACT_ADVOCATE_DEFAULT_WIDGET_ID = 'p/51699/w/referrerWidget';
const IMPACT_ADVOCATE_WIDGET_NAME = 'referrerWidget';
const IMPACT_ADVOCATE_VERIFIED_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

export type ImpactAdvocateIdentityPayload = {
  id: string;
  accountId: string;
  email: string;
  referable: boolean;
};

/**
 * SaaSquatch / Impact Advocate Upsert User accepts a strict allow-list of
 * fields. Per the program integration spec, these are the only keys SaaSquatch
 * will accept; any extra field is rejected with `INVALID_JSON_REQUEST`.
 *
 * Required: id, accountId, email, cookies.
 * Optional: firstName, lastName, locale, countryCode, segments, customFields.
 *
 * Note: `programId` is intentionally NOT part of this type. Earlier code
 * persisted it into request_payload rows; sanitizeRegisterParticipantPayloadForWire
 * strips it (and any other unknown field) before the request goes out, so old
 * rows can still be retried without a data migration.
 */
export type ImpactAdvocateRegisterParticipantPayload = {
  id: string;
  accountId: string;
  email: string;
  cookies: string;
  firstName?: string;
  lastName?: string;
  locale?: string;
  countryCode?: string;
  segments?: string[];
  customFields?: Record<string, unknown>;
};

const REGISTER_PARTICIPANT_ALLOWED_FIELDS = new Set<string>([
  'id',
  'accountId',
  'email',
  'cookies',
  'firstName',
  'lastName',
  'locale',
  'countryCode',
  'segments',
  'customFields',
]);

/**
 * Allow-list filter applied at the moment we hit the wire. Drops anything
 * SaaSquatch would reject and re-normalises locale (`en-US` -> `en_US`) so
 * persisted rows from before the locale fix retry cleanly.
 */
export function sanitizeRegisterParticipantPayloadForWire(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!REGISTER_PARTICIPANT_ALLOWED_FIELDS.has(key)) continue;
    if (key === 'locale' && typeof value === 'string') {
      const normalized = normalizeAdvocateLocale(value);
      if (normalized) sanitized[key] = normalized;
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

type ImpactAdvocateVerifiedAccessTokenPayload = {
  user: ImpactAdvocateIdentityPayload;
  exp: number;
};

type ImpactAdvocateJwtHeaderInput = {
  alg: 'HS256';
  kid: string;
};

export type ImpactAdvocateDispatchResult =
  | {
      ok: true;
      responseBody?: string;
      statusCode?: number;
    }
  | {
      ok: false;
      failureKind: 'http_4xx' | 'http_5xx' | 'network';
      statusCode?: number;
      responseBody?: string;
      error?: string;
    };

function getDebuggableRegisterParticipantPayload(
  payload: ImpactAdvocateRegisterParticipantPayload
) {
  return {
    ...payload,
    cookies: '[omitted: cookie value is sensitive]',
  };
}

function logImpactAdvocateDebug(message: string, details: Record<string, unknown>): void {
  // Delegates to the unified Impact debug logger so a single env
  // (IMPACT_REFERRAL_DEBUG=true, or NODE_ENV=development) lights up every
  // outbound Impact call site. IMPACT_ADVOCATE_DEBUG_LOGGING is still
  // honored as a legacy alias inside the unified gate.
  logImpactReferralDebug(message, details);
}

function getImpactAdvocateWidgetPath(widgetId: string, programId: string): string {
  const trimmedWidgetId = widgetId.trim();
  if (!trimmedWidgetId) return `p/${programId}/w/${IMPACT_ADVOCATE_WIDGET_NAME}`;
  if (trimmedWidgetId.includes('/')) return trimmedWidgetId;
  return `p/${trimmedWidgetId}/w/${IMPACT_ADVOCATE_WIDGET_NAME}`;
}

function getImpactAdvocateConfig() {
  const accountSid = IMPACT_ADVOCATE_ACCOUNT_SID || IMPACT_ACCOUNT_SID;
  const authToken = IMPACT_ADVOCATE_AUTH_TOKEN;
  const tenantAlias = IMPACT_ADVOCATE_TENANT_ALIAS;
  const programId = IMPACT_ADVOCATE_PROGRAM_ID || IMPACT_ADVOCATE_DEFAULT_PROGRAM_ID;
  const widgetId = getImpactAdvocateWidgetPath(IMPACT_ADVOCATE_WIDGET_ID, programId);

  if (!accountSid || !authToken || !tenantAlias) {
    return null;
  }

  return {
    accountSid,
    authToken,
    tenantAlias,
    programId,
    widgetId,
  };
}

export function isImpactAdvocateConfigured(): boolean {
  return getImpactAdvocateConfig() !== null;
}

export function getImpactAdvocateWidgetId(): string {
  return getImpactAdvocateConfig()?.widgetId ?? IMPACT_ADVOCATE_DEFAULT_WIDGET_ID;
}

export function getImpactAdvocateProgramId(): string {
  return getImpactAdvocateConfig()?.programId ?? IMPACT_ADVOCATE_DEFAULT_PROGRAM_ID;
}

/**
 * Pull the program-scoped referral code out of a SaaSquatch Upsert User
 * response body. The response shape is:
 *
 *   { ..., "referralCodes": { "<programId>": "<code>" }, ... }
 *
 * Returns null when the body is missing, malformed, or does not contain a
 * code for the requested programId. Never throws — callers treat null as
 * "no code, leave participants.opaque_referral_identifier alone".
 */
export function extractAdvocateReferralCodeFromUpsertResponse(
  responseBody: string | null | undefined,
  programId: string
): string | null {
  if (!responseBody) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const referralCodes = (parsed as Record<string, unknown>).referralCodes;
  if (typeof referralCodes !== 'object' || referralCodes === null) return null;
  const code = (referralCodes as Record<string, unknown>)[programId];
  if (typeof code !== 'string') return null;
  const trimmed = code.trim();
  return trimmed ? trimmed : null;
}

export function buildImpactAdvocateIdentityPayload(
  user: Pick<User, 'google_user_email'>
): ImpactAdvocateIdentityPayload {
  return {
    id: user.google_user_email,
    accountId: user.google_user_email,
    email: user.google_user_email,
    referable: false,
  };
}

export function buildImpactAdvocateRegisterParticipantPayload(params: {
  user: Pick<User, 'id' | 'google_user_email'>;
  referralCookieValue: string;
  locale?: string | null;
  countryCode?: string | null;
}): ImpactAdvocateRegisterParticipantPayload {
  const normalizedLocale = normalizeAdvocateLocale(params.locale);
  const payload: ImpactAdvocateRegisterParticipantPayload = {
    id: params.user.google_user_email,
    accountId: params.user.google_user_email,
    email: params.user.google_user_email,
    cookies: params.referralCookieValue,
    ...(normalizedLocale ? { locale: normalizedLocale } : {}),
    ...(params.countryCode ? { countryCode: params.countryCode } : {}),
  };

  logImpactAdvocateDebug('[impact-advocate] built register participant payload', {
    payload: getDebuggableRegisterParticipantPayload(payload),
  });

  return payload;
}

function getImpactAdvocateAuthorizationHeader(
  config: NonNullable<ReturnType<typeof getImpactAdvocateConfig>>
): string {
  return `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * SaaSquatch (Impact Advocate) Upsert User REST endpoint.
 *
 *   PUT {base}/api/v1/{tenantAlias}/open/account/{accountId}/user/{userId}
 *
 * accountId and userId are both the user's plain email per the program's
 * integration spec; we URL-encode them because the path segment contains '@'.
 */
function getImpactAdvocateRegisterParticipantUrl(
  config: NonNullable<ReturnType<typeof getImpactAdvocateConfig>>,
  payload: ImpactAdvocateRegisterParticipantPayload
): string {
  const base = trimTrailingSlashes(IMPACT_ADVOCATE_API_BASE_URL);
  const tenant = encodeURIComponent(config.tenantAlias);
  const accountId = encodeURIComponent(payload.accountId);
  const userId = encodeURIComponent(payload.id);
  return `${base}/api/v1/${tenant}/open/account/${accountId}/user/${userId}`;
}

export async function sendImpactAdvocateRegisterParticipantPayload(
  payload: ImpactAdvocateRegisterParticipantPayload
): Promise<ImpactAdvocateDispatchResult> {
  const config = getImpactAdvocateConfig();
  if (!config) {
    return {
      ok: false,
      failureKind: 'http_4xx',
      error: 'Impact Advocate is unconfigured',
    };
  }

  try {
    const url = getImpactAdvocateRegisterParticipantUrl(config, payload);
    const sanitizedPayload = sanitizeRegisterParticipantPayloadForWire(
      payload as unknown as Record<string, unknown>
    );
    logImpactAdvocateDebug('[impact-advocate] sending register participant request', {
      url,
      method: 'PUT',
      headers: {
        Authorization: 'not_logged',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      payload: getDebuggableRegisterParticipantPayload(
        sanitizedPayload as ImpactAdvocateRegisterParticipantPayload
      ),
    });

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: getImpactAdvocateAuthorizationHeader(config),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(sanitizedPayload),
    });

    const responseBody = await response.text();
    logImpactAdvocateDebug('[impact-advocate] register participant response', {
      url,
      ok: response.ok,
      statusCode: response.status,
      responseBody: truncateForLog(responseBody),
    });

    if (response.ok) {
      return {
        ok: true,
        statusCode: response.status,
        responseBody,
      };
    }

    return {
      ok: false,
      failureKind: response.status >= 500 ? 'http_5xx' : 'http_4xx',
      statusCode: response.status,
      responseBody,
    };
  } catch (error) {
    logImpactAdvocateDebug('[impact-advocate] register participant network error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      failureKind: 'network',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function issueImpactAdvocateVerifiedAccessToken(
  user: Pick<User, 'id' | 'google_user_email'>,
  now: Date = new Date()
): string | null {
  const config = getImpactAdvocateConfig();
  if (!config) return null;

  const header: ImpactAdvocateJwtHeaderInput = {
    alg: 'HS256',
    kid: config.accountSid,
  };
  const options: SignOptions = {
    algorithm: 'HS256',
    header,
    noTimestamp: true,
  };
  const payload: ImpactAdvocateVerifiedAccessTokenPayload = {
    user: buildImpactAdvocateIdentityPayload(user),
    exp: Math.floor(now.getTime() / 1000) + IMPACT_ADVOCATE_VERIFIED_ACCESS_TOKEN_TTL_SECONDS,
  };
  const token = jwt.sign(payload, config.authToken, options);

  logImpactAdvocateDebug('[impact-advocate] issued verified access token', {
    jwtHeader: header,
    jwtPayload: payload,
    signOptions: {
      algorithm: options.algorithm,
      noTimestamp: options.noTimestamp,
      expiresIn: options.expiresIn ?? null,
      subject: options.subject ?? null,
    },
    token: {
      omitted: 'not_logged',
      segmentLengths: token.split('.').map(segment => segment.length),
    },
  });

  return token;
}
