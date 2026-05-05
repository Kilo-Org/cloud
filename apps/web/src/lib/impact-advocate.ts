import 'server-only';

import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import type { User } from '@kilocode/db/schema';
import {
  IMPACT_ACCOUNT_SID,
  IMPACT_ADVOCATE_ACCOUNT_SID,
  IMPACT_ADVOCATE_AUTH_TOKEN,
  IMPACT_ADVOCATE_PROGRAM_ID,
  IMPACT_ADVOCATE_TENANT_ALIAS,
  IMPACT_ADVOCATE_WIDGET_ID,
} from '@/lib/config.server';

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

export type ImpactAdvocateRegisterParticipantPayload = {
  id: string;
  accountId: string;
  programId: string;
  email: string;
  cookies: string;
  locale?: string;
  countryCode?: string;
};

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

function isImpactAdvocateDebugLoggingEnabled(): boolean {
  const value = process.env.IMPACT_ADVOCATE_DEBUG_LOGGING?.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

function logImpactAdvocateDebug(message: string, details: Record<string, unknown>): void {
  if (!isImpactAdvocateDebugLoggingEnabled()) return;
  console.warn(`${message} ${JSON.stringify(details)}`);
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
  const config = getImpactAdvocateConfig();
  const payload: ImpactAdvocateRegisterParticipantPayload = {
    id: params.user.google_user_email,
    accountId: params.user.google_user_email,
    programId: config?.programId ?? IMPACT_ADVOCATE_DEFAULT_PROGRAM_ID,
    email: params.user.google_user_email,
    cookies: params.referralCookieValue,
    ...(params.locale ? { locale: params.locale } : {}),
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

function getImpactAdvocateRegisterParticipantUrl(
  config: NonNullable<ReturnType<typeof getImpactAdvocateConfig>>
): string {
  return `https://api.impact.com/Advocate/${config.tenantAlias}/Programs/${config.programId}/Participants`;
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
    const url = getImpactAdvocateRegisterParticipantUrl(config);
    logImpactAdvocateDebug('[impact-advocate] sending register participant request', {
      url,
      method: 'POST',
      headers: {
        Authorization: 'not_logged',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      payload: getDebuggableRegisterParticipantPayload(payload),
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: getImpactAdvocateAuthorizationHeader(config),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const responseBody = await response.text();
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
