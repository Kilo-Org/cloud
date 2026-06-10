import 'server-only';

import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import type { User } from '@kilocode/db/schema';
import {
  IMPACT_ADVOCATE_ACCOUNT_SID,
  IMPACT_ADVOCATE_API_BASE_URL,
  IMPACT_ADVOCATE_AUTH_TOKEN,
  IMPACT_ADVOCATE_KILOCLAW_PROGRAM_ID,
  IMPACT_ADVOCATE_KILOCLAW_WIDGET_ID,
  IMPACT_ADVOCATE_KILO_PASS_PROGRAM_ID,
  IMPACT_ADVOCATE_KILO_PASS_WIDGET_ID,
  IMPACT_ADVOCATE_TENANT_ALIAS,
} from '@/lib/config.server';
import { logImpactReferralDebug, truncateForLog } from '@/lib/impact/debug';
import { ImpactAdvocateProgramKey, ImpactReferralProduct } from '@kilocode/db/schema-types';

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

const IMPACT_ADVOCATE_WIDGET_NAME = 'referrerWidget';
const IMPACT_ADVOCATE_VERIFIED_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

type ImpactAdvocateConfigScope = {
  product?: ImpactReferralProduct;
  programKey?: ImpactAdvocateProgramKey;
};

type ImpactAdvocateConfig = {
  accountSid: string;
  authToken: string;
  tenantAlias: string;
  programId: string;
  widgetId: string;
  programKey: ImpactAdvocateProgramKey;
};

export function getImpactAdvocateProgramKeyForProduct(
  product: ImpactReferralProduct
): ImpactAdvocateProgramKey {
  return product === ImpactReferralProduct.KiloPass
    ? ImpactAdvocateProgramKey.KiloPass
    : ImpactAdvocateProgramKey.KiloClaw;
}

function resolveImpactAdvocateProgramKey(
  scope?: ImpactAdvocateConfigScope
): ImpactAdvocateProgramKey {
  if (scope?.programKey) return scope.programKey;
  if (scope?.product) return getImpactAdvocateProgramKeyForProduct(scope.product);
  return ImpactAdvocateProgramKey.KiloClaw;
}

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

export type ImpactAdvocateRewardLookupPayload = {
  accountId: string;
  userId?: string;
  rewardTypeFilter?: 'CREDIT';
};

export type ImpactAdvocateRewardRedemptionPayload = {
  rewardId: string;
  amount: number;
  unit: string;
};

export type ImpactAdvocateRewardListResult = ImpactAdvocateDispatchResult & {
  rewards?: unknown[];
};

function redactAdvocateEmailIdentityForLog(value: string | null | undefined): string | null {
  return value?.trim() ? '[omitted: email identity is PII]' : null;
}

function truncateAndRedactAdvocateResponseForLog(value: string | null | undefined): string | null {
  return (
    truncateForLog(value)?.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]') ??
    null
  );
}

function getDebuggableRegisterParticipantPayload(
  payload: ImpactAdvocateRegisterParticipantPayload
) {
  return {
    id: redactAdvocateEmailIdentityForLog(payload.id),
    accountId: redactAdvocateEmailIdentityForLog(payload.accountId),
    email: redactAdvocateEmailIdentityForLog(payload.email),
    cookies: '[omitted: cookie value is sensitive]',
    firstName: payload.firstName ? '[omitted: name is PII]' : undefined,
    lastName: payload.lastName ? '[omitted: name is PII]' : undefined,
    locale: payload.locale,
    countryCode: payload.countryCode,
    segments: payload.segments,
    customFieldsPresent: payload.customFields ? true : undefined,
  };
}

function getDebuggableVerifiedAccessTokenPayload(
  payload: ImpactAdvocateVerifiedAccessTokenPayload
): ImpactAdvocateVerifiedAccessTokenPayload {
  return {
    ...payload,
    user: {
      ...payload.user,
      id: redactAdvocateEmailIdentityForLog(payload.user.id) ?? '',
      accountId: redactAdvocateEmailIdentityForLog(payload.user.accountId) ?? '',
      email: redactAdvocateEmailIdentityForLog(payload.user.email) ?? '',
    },
  };
}

function configuredValue(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed !== 'undefined' ? trimmed : '';
}

function getImpactAdvocateWidgetPath(widgetId: string, programId: string): string {
  const trimmedWidgetId = widgetId.trim();
  if (!trimmedWidgetId) return `p/${programId}/w/${IMPACT_ADVOCATE_WIDGET_NAME}`;
  if (trimmedWidgetId.includes('/')) return trimmedWidgetId;
  return `p/${trimmedWidgetId}/w/${IMPACT_ADVOCATE_WIDGET_NAME}`;
}

function getKiloClawAdvocateIdentifiersForComparison(): {
  programIds: Set<string>;
  widgetIds: Set<string>;
} {
  const programId = configuredValue(IMPACT_ADVOCATE_KILOCLAW_PROGRAM_ID);
  const rawWidgetId = configuredValue(IMPACT_ADVOCATE_KILOCLAW_WIDGET_ID);
  const programIds = new Set<string>();
  const widgetIds = new Set<string>();

  if (programId) {
    programIds.add(programId);
  }
  if (programId && rawWidgetId) {
    widgetIds.add(getImpactAdvocateWidgetPath(rawWidgetId, programId));
  }

  return { programIds, widgetIds };
}

function kiloPassAdvocateConfigReusesKiloClawIdentifiers(params: {
  programId: string;
  widgetId: string;
}): boolean {
  const kiloClawIdentifiers = getKiloClawAdvocateIdentifiersForComparison();
  return (
    kiloClawIdentifiers.programIds.has(params.programId) ||
    kiloClawIdentifiers.widgetIds.has(params.widgetId)
  );
}

function getImpactAdvocateConfig(scope?: ImpactAdvocateConfigScope): ImpactAdvocateConfig | null {
  const programKey = resolveImpactAdvocateProgramKey(scope);

  const scopedValues =
    programKey === ImpactAdvocateProgramKey.KiloPass
      ? {
          programId: configuredValue(IMPACT_ADVOCATE_KILO_PASS_PROGRAM_ID),
          widgetId: configuredValue(IMPACT_ADVOCATE_KILO_PASS_WIDGET_ID),
        }
      : {
          programId: configuredValue(IMPACT_ADVOCATE_KILOCLAW_PROGRAM_ID),
          widgetId: configuredValue(IMPACT_ADVOCATE_KILOCLAW_WIDGET_ID),
        };

  const accountSid = configuredValue(IMPACT_ADVOCATE_ACCOUNT_SID);
  const authToken = configuredValue(IMPACT_ADVOCATE_AUTH_TOKEN);
  const tenantAlias = configuredValue(IMPACT_ADVOCATE_TENANT_ALIAS);
  const programId = scopedValues.programId;
  const rawWidgetId = scopedValues.widgetId;

  if (!accountSid || !authToken || !tenantAlias || !programId || !rawWidgetId) {
    return null;
  }

  const widgetId = getImpactAdvocateWidgetPath(rawWidgetId, programId);

  if (!widgetId) {
    return null;
  }

  if (
    programKey === ImpactAdvocateProgramKey.KiloPass &&
    kiloPassAdvocateConfigReusesKiloClawIdentifiers({ programId, widgetId })
  ) {
    return null;
  }

  return {
    accountSid,
    authToken,
    tenantAlias,
    programId,
    widgetId,
    programKey,
  };
}

export function isImpactAdvocateConfigured(scope?: ImpactAdvocateConfigScope): boolean {
  return getImpactAdvocateConfig(scope) !== null;
}

export function getImpactAdvocateWidgetId(scope?: ImpactAdvocateConfigScope): string | null {
  const programKey = resolveImpactAdvocateProgramKey(scope);
  return getImpactAdvocateConfig({ programKey })?.widgetId ?? null;
}

export function getImpactAdvocateProgramId(scope?: ImpactAdvocateConfigScope): string | null {
  const programKey = resolveImpactAdvocateProgramKey(scope);
  return getImpactAdvocateConfig({ programKey })?.programId ?? null;
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

  logImpactReferralDebug('[impact-advocate] built register participant payload', {
    payload: getDebuggableRegisterParticipantPayload(payload),
  });

  return payload;
}

function getImpactAdvocateAuthorizationHeader(config: ImpactAdvocateConfig): string {
  return `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getCaseInsensitiveProperty(record: Record<string, unknown>, key: string): unknown {
  if (Object.prototype.hasOwnProperty.call(record, key)) {
    return record[key];
  }

  const lowerKey = key.toLowerCase();
  const matchedKey = Object.keys(record).find(candidate => candidate.toLowerCase() === lowerKey);
  return matchedKey ? record[matchedKey] : undefined;
}

export function extractImpactAdvocateRewards(responseBody: string | null | undefined): unknown[] {
  if (!responseBody) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return [];
  }

  if (Array.isArray(parsed)) return parsed;
  if (!isRecord(parsed)) return [];

  const candidateKeys = [
    'rewards',
    'Rewards',
    'data',
    'Data',
    'items',
    'Items',
    'results',
    'Results',
  ];
  for (const key of candidateKeys) {
    const candidate = getCaseInsensitiveProperty(parsed, key);
    if (Array.isArray(candidate)) return candidate;
  }

  return [];
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
  config: ImpactAdvocateConfig,
  payload: ImpactAdvocateRegisterParticipantPayload
): string {
  const base = trimTrailingSlashes(IMPACT_ADVOCATE_API_BASE_URL);
  const tenant = encodeURIComponent(config.tenantAlias);
  const accountId = encodeURIComponent(payload.accountId);
  const userId = encodeURIComponent(payload.id);
  return `${base}/api/v1/${tenant}/open/account/${accountId}/user/${userId}`;
}

function getDebuggableImpactAdvocateRegisterParticipantUrl(config: ImpactAdvocateConfig): string {
  const base = trimTrailingSlashes(IMPACT_ADVOCATE_API_BASE_URL);
  const tenant = encodeURIComponent(config.tenantAlias);
  return `${base}/api/v1/${tenant}/open/account/[redacted-account-id]/user/[redacted-user-id]`;
}

function getImpactAdvocateRewardsUrl(
  config: ImpactAdvocateConfig,
  payload: ImpactAdvocateRewardLookupPayload
): string {
  const base = trimTrailingSlashes(IMPACT_ADVOCATE_API_BASE_URL);
  const tenant = encodeURIComponent(config.tenantAlias);
  const url = new URL(`${base}/api/v1/${tenant}/reward`);
  url.searchParams.set('accountId', payload.accountId);
  if (payload.userId) url.searchParams.set('userId', payload.userId);
  if (payload.rewardTypeFilter) url.searchParams.set('rewardTypeFilter', payload.rewardTypeFilter);
  return url.toString();
}

function getDebuggableImpactAdvocateRewardsUrl(
  config: ImpactAdvocateConfig,
  payload: ImpactAdvocateRewardLookupPayload
): string {
  const base = trimTrailingSlashes(IMPACT_ADVOCATE_API_BASE_URL);
  const tenant = encodeURIComponent(config.tenantAlias);
  const url = new URL(`${base}/api/v1/${tenant}/reward`);
  url.searchParams.set('accountId', 'redacted');
  if (payload.userId) url.searchParams.set('userId', 'redacted');
  if (payload.rewardTypeFilter) url.searchParams.set('rewardTypeFilter', payload.rewardTypeFilter);
  return url.toString();
}

function getImpactAdvocateRedeemRewardUrl(config: ImpactAdvocateConfig, rewardId: string): string {
  const base = trimTrailingSlashes(IMPACT_ADVOCATE_API_BASE_URL);
  const tenant = encodeURIComponent(config.tenantAlias);
  return `${base}/api/v1/${tenant}/credit/${encodeURIComponent(rewardId)}/redeem`;
}

export async function sendImpactAdvocateRegisterParticipantPayload(
  payload: ImpactAdvocateRegisterParticipantPayload,
  scope?: ImpactAdvocateConfigScope
): Promise<ImpactAdvocateDispatchResult> {
  const config = getImpactAdvocateConfig(scope);
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
    logImpactReferralDebug('[impact-advocate] sending register participant request', {
      url: getDebuggableImpactAdvocateRegisterParticipantUrl(config),
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
    logImpactReferralDebug('[impact-advocate] register participant response', {
      url: getDebuggableImpactAdvocateRegisterParticipantUrl(config),
      ok: response.ok,
      statusCode: response.status,
      responseBody: truncateAndRedactAdvocateResponseForLog(responseBody),
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
    logImpactReferralDebug('[impact-advocate] register participant network error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      failureKind: 'network',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function sendImpactAdvocateRewardLookupPayload(
  payload: ImpactAdvocateRewardLookupPayload,
  scope?: ImpactAdvocateConfigScope
): Promise<ImpactAdvocateRewardListResult> {
  const config = getImpactAdvocateConfig(scope);
  if (!config) {
    return {
      ok: false,
      failureKind: 'http_4xx',
      error: 'Impact Advocate is unconfigured',
    };
  }

  try {
    const url = getImpactAdvocateRewardsUrl(config, payload);
    logImpactReferralDebug('[impact-advocate] sending reward lookup request', {
      url: getDebuggableImpactAdvocateRewardsUrl(config, payload),
      method: 'GET',
      accountIdPresent: Boolean(payload.accountId.trim()),
      userIdPresent: Boolean(payload.userId?.trim()),
      rewardTypeFilter: payload.rewardTypeFilter ?? null,
    });

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: getImpactAdvocateAuthorizationHeader(config),
        Accept: 'application/json',
      },
    });
    const responseBody = await response.text();

    logImpactReferralDebug('[impact-advocate] reward lookup response', {
      url: getDebuggableImpactAdvocateRewardsUrl(config, payload),
      ok: response.ok,
      statusCode: response.status,
      responseBody: truncateAndRedactAdvocateResponseForLog(responseBody),
    });

    if (response.ok) {
      return {
        ok: true,
        statusCode: response.status,
        responseBody,
        rewards: extractImpactAdvocateRewards(responseBody),
      };
    }

    return {
      ok: false,
      failureKind: response.status >= 500 ? 'http_5xx' : 'http_4xx',
      statusCode: response.status,
      responseBody,
    };
  } catch (error) {
    logImpactReferralDebug('[impact-advocate] reward lookup network error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      failureKind: 'network',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function sendImpactAdvocateRewardRedemptionPayload(
  payload: ImpactAdvocateRewardRedemptionPayload,
  scope?: ImpactAdvocateConfigScope
): Promise<ImpactAdvocateDispatchResult> {
  const config = getImpactAdvocateConfig(scope);
  if (!config) {
    return {
      ok: false,
      failureKind: 'http_4xx',
      error: 'Impact Advocate is unconfigured',
    };
  }

  try {
    const url = getImpactAdvocateRedeemRewardUrl(config, payload.rewardId);
    const body = {
      amount: payload.amount,
      unit: payload.unit,
    };
    logImpactReferralDebug('[impact-advocate] sending reward redemption request', {
      url,
      method: 'POST',
      rewardIdPresent: Boolean(payload.rewardId.trim()),
      amount: payload.amount,
      unit: payload.unit,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: getImpactAdvocateAuthorizationHeader(config),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const responseBody = await response.text();

    logImpactReferralDebug('[impact-advocate] reward redemption response', {
      url,
      ok: response.ok,
      statusCode: response.status,
      responseBody: truncateAndRedactAdvocateResponseForLog(responseBody),
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
    logImpactReferralDebug('[impact-advocate] reward redemption network error', {
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
  now: Date = new Date(),
  scope?: ImpactAdvocateConfigScope
): string | null {
  const config = getImpactAdvocateConfig(scope);
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

  logImpactReferralDebug('[impact-advocate] issued verified access token', {
    jwtHeader: header,
    jwtPayload: getDebuggableVerifiedAccessTokenPayload(payload),
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
