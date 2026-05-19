import { createHmac } from 'node:crypto';

export const ADMIN_SESSION_TRACE_PSEUDONYM_KEY_ENV = 'ADMIN_SESSION_TRACE_PSEUDONYM_KEY';
export const PSEUDONYM_TOKEN_PREFIX = 'hmac-sha256:v1:';

const PSEUDONYM_TOKEN_PATTERN = /^hmac-sha256:v1:[A-Za-z0-9_-]{43}$/;
const PSEUDONYM_INPUT_NAMESPACE = 'admin-session-trace:v1';
const USER_FIELD_DOMAINS = {
  id: 'user-id',
  email: 'email',
  name: 'name',
  image: 'image',
} as const;

type UserField = keyof typeof USER_FIELD_DOMAINS;

type JsonObject = Record<string, unknown>;

export type AdminSessionTracePseudonymizationResult = {
  trace: unknown;
  changed: boolean;
  pseudonymizedFieldCount: number;
  alreadyPseudonymizedFieldCount: number;
};

export function requirePseudonymKey(rawKey: string | undefined, source: string): string {
  const key = rawKey?.trim() ?? '';
  if (!key) {
    throw new Error(`Missing non-empty admin session trace pseudonym key in ${source}`);
  }
  return key;
}

export function isPseudonymToken(value: string): boolean {
  return PSEUDONYM_TOKEN_PATTERN.test(value);
}

export function pseudonymizeAdminSessionTrace(
  trace: unknown,
  key: string
): AdminSessionTracePseudonymizationResult {
  requirePseudonymKey(key, 'the provided key');

  if (!isJsonObject(trace)) {
    return unchanged(trace);
  }

  let traceCopy: JsonObject | null = null;
  let pseudonymizedFieldCount = 0;
  let alreadyPseudonymizedFieldCount = 0;

  const kiloUserIdResult = pseudonymizeTargetValue(
    trace.kilo_user_id,
    'user-id',
    key,
    'kilo_user_id'
  );
  if (kiloUserIdResult.status === 'changed') {
    traceCopy = traceCopy ?? { ...trace };
    traceCopy.kilo_user_id = kiloUserIdResult.value;
    pseudonymizedFieldCount++;
  } else if (kiloUserIdResult.status === 'already-pseudonymized') {
    alreadyPseudonymizedFieldCount++;
  }

  if (Object.prototype.hasOwnProperty.call(trace, 'user')) {
    const userValue = trace.user;
    if (userValue !== null && userValue !== undefined && !isJsonObject(userValue)) {
      throw new Error('admin_session_trace.user must be an object, null, or absent');
    }

    if (isJsonObject(userValue)) {
      let userCopy: JsonObject | null = null;
      for (const field of Object.keys(USER_FIELD_DOMAINS) as UserField[]) {
        const result = pseudonymizeTargetValue(
          userValue[field],
          USER_FIELD_DOMAINS[field],
          key,
          `user.${field}`
        );
        if (result.status === 'changed') {
          userCopy = userCopy ?? { ...userValue };
          userCopy[field] = result.value;
          pseudonymizedFieldCount++;
        } else if (result.status === 'already-pseudonymized') {
          alreadyPseudonymizedFieldCount++;
        }
      }

      if (userCopy) {
        traceCopy = traceCopy ?? { ...trace };
        traceCopy.user = userCopy;
      }
    }
  }

  return {
    trace: traceCopy ?? trace,
    changed: traceCopy !== null,
    pseudonymizedFieldCount,
    alreadyPseudonymizedFieldCount,
  };
}

function unchanged(trace: unknown): AdminSessionTracePseudonymizationResult {
  return {
    trace,
    changed: false,
    pseudonymizedFieldCount: 0,
    alreadyPseudonymizedFieldCount: 0,
  };
}

function pseudonymizeTargetValue(
  value: unknown,
  domain: string,
  key: string,
  fieldName: string
):
  | { status: 'unchanged' }
  | { status: 'already-pseudonymized' }
  | { status: 'changed'; value: string } {
  if (value === null || value === undefined) {
    return { status: 'unchanged' };
  }
  if (typeof value !== 'string') {
    throw new Error(`admin_session_trace.${fieldName} must be a string, null, or absent`);
  }
  if (isPseudonymToken(value)) {
    return { status: 'already-pseudonymized' };
  }
  return {
    status: 'changed',
    value: pseudonymizeString(value, domain, key),
  };
}

function pseudonymizeString(value: string, domain: string, key: string): string {
  const digest = createHmac('sha256', key)
    .update(`${PSEUDONYM_INPUT_NAMESPACE}:${domain}\0${value}`, 'utf8')
    .digest('base64url');
  return `${PSEUDONYM_TOKEN_PREFIX}${digest}`;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
