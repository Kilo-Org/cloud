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

export type ImpactAdvocateIdentityPayload = {
  id: string;
  accountId: string;
  email: string;
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

function getImpactAdvocateConfig() {
  const accountSid = IMPACT_ADVOCATE_ACCOUNT_SID || IMPACT_ACCOUNT_SID;
  const authToken = IMPACT_ADVOCATE_AUTH_TOKEN;
  const tenantAlias = IMPACT_ADVOCATE_TENANT_ALIAS;
  const programId = IMPACT_ADVOCATE_PROGRAM_ID || IMPACT_ADVOCATE_DEFAULT_PROGRAM_ID;
  const widgetId = IMPACT_ADVOCATE_WIDGET_ID || IMPACT_ADVOCATE_DEFAULT_WIDGET_ID;

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
  user: Pick<User, 'id' | 'google_user_email'>
): ImpactAdvocateIdentityPayload {
  return {
    id: user.id,
    accountId: user.id,
    email: user.google_user_email,
  };
}

export function buildImpactAdvocateRegisterParticipantPayload(params: {
  user: Pick<User, 'id' | 'google_user_email'>;
  referralCookieValue: string;
  locale?: string | null;
  countryCode?: string | null;
}): ImpactAdvocateRegisterParticipantPayload {
  const config = getImpactAdvocateConfig();

  return {
    id: params.user.id,
    accountId: params.user.id,
    programId: config?.programId ?? IMPACT_ADVOCATE_DEFAULT_PROGRAM_ID,
    email: params.user.google_user_email,
    cookies: params.referralCookieValue,
    ...(params.locale ? { locale: params.locale } : {}),
    ...(params.countryCode ? { countryCode: params.countryCode } : {}),
  };
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
    const response = await fetch(getImpactAdvocateRegisterParticipantUrl(config), {
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

  const options: SignOptions = {
    algorithm: 'HS256',
    expiresIn: '5m',
    header: {
      alg: 'HS256',
      kid: config.accountSid,
    },
    subject: user.id,
  };

  return jwt.sign(
    {
      iss: config.tenantAlias,
      aud: 'impact-advocate',
      iat: Math.floor(now.getTime() / 1000),
      user: buildImpactAdvocateIdentityPayload(user),
    },
    config.authToken,
    options
  );
}
