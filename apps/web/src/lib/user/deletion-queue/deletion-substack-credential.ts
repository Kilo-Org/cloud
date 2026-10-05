import { and, eq, sql } from 'drizzle-orm';
import { user_deletion_provider_credentials } from '@kilocode/db/schema';
import { UserDeletionProviderScope } from '@kilocode/db/schema-types';
import { getEnvVariable } from '@/lib/dotenvx';
import { db } from '@/lib/drizzle';
import { USER_DELETION_DEFAULT_SUBSTACK_PUBLICATION_URL } from '@/lib/user/deletion-queue/deletion-constants';
import {
  decryptDeletionCredential,
  DeletionCryptoError,
  encryptDeletionCredential,
} from '@/lib/user/deletion-queue/deletion-crypto';
import {
  applyResponseCookies,
  reauthenticateSubstackSession,
  type SubstackReauthFailure,
} from '@/lib/user/deletion-queue/substack-session';
import { normalizeTotpSecret } from '@/lib/user/deletion-queue/substack-totp';

const SUBSTACK_PROFILE_TIMEOUT_MS = 15_000;
const SUBSTACK_COM_ORIGIN = 'https://substack.com';

export type SubstackCredentialTestResult =
  | { status: 'healthy'; handle: string | null; name: string | null; totpVerified: boolean }
  | { status: 'expired' }
  | { status: 'error'; errorCode: string };

export type ParsedSubstackCredential = {
  cookie: string;
  totpSecret: string | null;
};

export type SubstackCredentialParseResult =
  | { ok: true; credential: ParsedSubstackCredential }
  | { ok: false; reason: 'invalid_material' | 'invalid_totp' };

export type SubstackCredentialTestOutcome = {
  result: SubstackCredentialTestResult;
  refreshedCookie: string | null;
};

export class SubstackCredentialInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubstackCredentialInputError';
  }
}

export function parseSubstackCredential(material: string): SubstackCredentialParseResult {
  const trimmed = material.trim();
  if (!trimmed) return { ok: false, reason: 'invalid_material' };

  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { ok: false, reason: 'invalid_material' };
    }
    if (!isRecord(parsed)) return { ok: false, reason: 'invalid_material' };

    const cookie =
      asNonEmptyString(parsed.cookie) ??
      (asNonEmptyString(parsed.sid) ? `connect.sid=${asNonEmptyString(parsed.sid)}` : null);
    if (!cookie || hasControlCharacters(cookie)) return { ok: false, reason: 'invalid_material' };

    if (parsed.totpSecret === undefined || parsed.totpSecret === null) {
      return { ok: true, credential: { cookie, totpSecret: null } };
    }
    if (typeof parsed.totpSecret !== 'string') return { ok: false, reason: 'invalid_totp' };
    if (!parsed.totpSecret.trim()) return { ok: true, credential: { cookie, totpSecret: null } };
    const totpSecret = normalizeTotpSecret(parsed.totpSecret);
    if (!totpSecret) return { ok: false, reason: 'invalid_totp' };
    return { ok: true, credential: { cookie, totpSecret } };
  }

  if (hasControlCharacters(trimmed)) return { ok: false, reason: 'invalid_material' };
  const cookie = trimmed.includes('=') ? trimmed : `connect.sid=${trimmed}`;
  return { ok: true, credential: { cookie, totpSecret: null } };
}

export function serializeSubstackCredential(credential: ParsedSubstackCredential): string {
  return JSON.stringify(
    credential.totpSecret
      ? { cookie: credential.cookie, totpSecret: credential.totpSecret }
      : { cookie: credential.cookie }
  );
}

export function getSubstackPublicationUrl(): string {
  return (
    getEnvVariable('SUBSTACK_PUBLICATION_URL').trim().replace(/\/$/, '') ||
    USER_DELETION_DEFAULT_SUBSTACK_PUBLICATION_URL
  );
}

export async function testSubstackCredentialMaterial(
  material: string,
  totpSecret?: string
): Promise<SubstackCredentialTestOutcome> {
  const parsed = parseSubstackCredential(material);
  if (!parsed.ok) return { result: parseFailureResult(parsed.reason), refreshedCookie: null };

  let effectiveSecret = parsed.credential.totpSecret;
  if (totpSecret !== undefined) {
    const trimmed = totpSecret.trim();
    if (trimmed) {
      const normalized = normalizeTotpSecret(trimmed);
      if (!normalized) {
        return {
          result: { status: 'error', errorCode: 'substack_totp_invalid' },
          refreshedCookie: null,
        };
      }
      effectiveSecret = normalized;
    } else {
      effectiveSecret = null;
    }
  }

  const outcome = await runSubstackCredentialTest({
    cookie: parsed.credential.cookie,
    totpSecret: effectiveSecret,
  });
  return {
    result: outcome.result,
    refreshedCookie:
      outcome.result.status === 'healthy' && outcome.cookieChanged ? outcome.cookie : null,
  };
}

export async function testStoredSubstackCredential(): Promise<
  SubstackCredentialTestResult | { status: 'missing' }
> {
  const [credential] = await db
    .select({ encrypted_material: user_deletion_provider_credentials.encrypted_material })
    .from(user_deletion_provider_credentials)
    .where(
      eq(user_deletion_provider_credentials.provider_scope, UserDeletionProviderScope.Substack)
    )
    .limit(1);
  if (!credential) {
    return { status: 'missing' };
  }

  let material: string;
  try {
    material = decryptDeletionCredential(credential.encrypted_material);
  } catch (error) {
    if (error instanceof DeletionCryptoError) {
      return { status: 'error', errorCode: 'credential_invalid' };
    }
    throw error;
  }

  const parsed = parseSubstackCredential(material);
  if (!parsed.ok) return parseFailureResult(parsed.reason);

  const outcome = await runSubstackCredentialTest(parsed.credential);
  if (outcome.cookieChanged && outcome.cookie.trim()) {
    try {
      const { persisted } = await persistRefreshedSubstackCookie({
        originalEncryptedMaterial: credential.encrypted_material,
        cookie: outcome.cookie,
        totpSecret: parsed.credential.totpSecret,
      });
      if (outcome.result.status === 'healthy' && !persisted) {
        return { status: 'error', errorCode: 'substack_credential_changed' };
      }
    } catch {
      if (outcome.result.status === 'healthy') {
        return { status: 'error', errorCode: 'substack_cookie_persist_failed' };
      }
    }
  }
  return outcome.result;
}

export async function replaceSubstackCredential(params: {
  material: string;
  totpSecret?: string | null;
  actorKiloUserId: string;
}): Promise<void> {
  const parsed = parseSubstackCredential(params.material);
  if (!parsed.ok) {
    throw new SubstackCredentialInputError(
      parsed.reason === 'invalid_totp'
        ? 'Invalid TOTP secret.'
        : 'Invalid Substack credential material.'
    );
  }

  let totpSecret = parsed.credential.totpSecret;
  if (params.totpSecret !== undefined && params.totpSecret !== null) {
    const trimmed = params.totpSecret.trim();
    if (trimmed) {
      const normalized = normalizeTotpSecret(trimmed);
      if (!normalized) throw new SubstackCredentialInputError('Invalid TOTP secret.');
      totpSecret = normalized;
    } else {
      totpSecret = null;
    }
  }

  const material = serializeSubstackCredential({ cookie: parsed.credential.cookie, totpSecret });
  const encrypted = encryptDeletionCredential(material);
  await db
    .insert(user_deletion_provider_credentials)
    .values({
      provider_scope: UserDeletionProviderScope.Substack,
      encrypted_material: encrypted,
      updated_by_kilo_user_id: params.actorKiloUserId,
    })
    .onConflictDoUpdate({
      target: user_deletion_provider_credentials.provider_scope,
      set: {
        encrypted_material: encrypted,
        updated_by_kilo_user_id: params.actorKiloUserId,
      },
    });
}

export async function persistRefreshedSubstackCookie(params: {
  originalEncryptedMaterial: string;
  cookie: string;
  totpSecret: string | null;
}): Promise<{ persisted: boolean }> {
  const material = serializeSubstackCredential({
    cookie: params.cookie,
    totpSecret: params.totpSecret,
  });
  const encrypted = encryptDeletionCredential(material);
  const updated = await db
    .update(user_deletion_provider_credentials)
    .set({ encrypted_material: encrypted, updated_at: sql`now()` })
    .where(
      and(
        eq(user_deletion_provider_credentials.provider_scope, UserDeletionProviderScope.Substack),
        eq(user_deletion_provider_credentials.encrypted_material, params.originalEncryptedMaterial)
      )
    )
    .returning({ provider_scope: user_deletion_provider_credentials.provider_scope });
  return { persisted: updated.length > 0 };
}

export async function deleteSubstackCredential(): Promise<{ deleted: boolean }> {
  const deleted = await db
    .delete(user_deletion_provider_credentials)
    .where(
      eq(user_deletion_provider_credentials.provider_scope, UserDeletionProviderScope.Substack)
    )
    .returning({ provider_scope: user_deletion_provider_credentials.provider_scope });
  return { deleted: deleted.length > 0 };
}

export async function getSubstackCredentialMeta(): Promise<{
  configured: boolean;
  totpConfigured: boolean;
  updatedAt: string | null;
  updatedByKiloUserId: string | null;
}> {
  const [row] = await db
    .select({
      encrypted_material: user_deletion_provider_credentials.encrypted_material,
      updated_at: user_deletion_provider_credentials.updated_at,
      updated_by_kilo_user_id: user_deletion_provider_credentials.updated_by_kilo_user_id,
    })
    .from(user_deletion_provider_credentials)
    .where(
      eq(user_deletion_provider_credentials.provider_scope, UserDeletionProviderScope.Substack)
    )
    .limit(1);
  if (!row) {
    return { configured: false, totpConfigured: false, updatedAt: null, updatedByKiloUserId: null };
  }

  let totpConfigured = false;
  try {
    const parsed = parseSubstackCredential(decryptDeletionCredential(row.encrypted_material));
    totpConfigured = parsed.ok
      ? parsed.credential.totpSecret !== null
      : parsed.reason === 'invalid_totp';
  } catch {
    totpConfigured = false;
  }

  return {
    configured: true,
    totpConfigured,
    updatedAt: new Date(row.updated_at).toISOString(),
    updatedByKiloUserId: row.updated_by_kilo_user_id,
  };
}

async function runSubstackCredentialTest(credential: ParsedSubstackCredential): Promise<{
  result: SubstackCredentialTestResult;
  cookie: string;
  cookieChanged: boolean;
}> {
  const publication = getSubstackPublicationUrl();
  const profile = await testSubstackProfile(publication, credential.cookie);
  if (profile.result.status !== 'healthy' || !credential.totpSecret) {
    return {
      result: profile.result,
      cookie: profile.cookie,
      cookieChanged: profile.cookie !== credential.cookie,
    };
  }

  const reauth = await reauthenticateSubstackSession({
    publication,
    cookie: profile.cookie,
    totpSecret: credential.totpSecret,
    timeoutMs: SUBSTACK_PROFILE_TIMEOUT_MS,
  });
  if (!reauth.ok) {
    return {
      result: reauthFailureResult(reauth.failure),
      cookie: reauth.cookie,
      cookieChanged: reauth.cookie !== credential.cookie,
    };
  }
  return {
    result: { ...profile.result, totpVerified: true },
    cookie: reauth.cookie,
    cookieChanged: reauth.cookie !== credential.cookie,
  };
}

async function testSubstackProfile(
  publication: string,
  cookie: string
): Promise<{ result: SubstackCredentialTestResult; cookie: string }> {
  const profileUrl = `${publication}/api/v1/user/profile/self`;
  const first = await fetchSubstackProfile(profileUrl, cookie);
  let workingCookie = cookie;
  if (first.kind !== 'response') {
    return { result: await classifySubstackProfileResponse(first), cookie: workingCookie };
  }
  workingCookie = applyResponseCookies(workingCookie, first.response);
  if (first.response.status === 404 && publication !== SUBSTACK_COM_ORIGIN) {
    // The substack.com fallback verifies the session only; its Set-Cookie values must not leak into the publication session.
    const fallback = await fetchSubstackProfile(
      `${SUBSTACK_COM_ORIGIN}/api/v1/user/profile/self`,
      workingCookie
    );
    return { result: await classifySubstackProfileResponse(fallback), cookie: workingCookie };
  }
  return { result: await classifySubstackProfileResponse(first), cookie: workingCookie };
}

type ProfileFetchResult =
  | { kind: 'response'; response: Response }
  | { kind: 'error'; errorCode: string };

async function fetchSubstackProfile(url: string, cookie: string): Promise<ProfileFetchResult> {
  try {
    const response = await fetch(url, {
      headers: { Cookie: cookie, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(SUBSTACK_PROFILE_TIMEOUT_MS),
    });
    return { kind: 'response', response };
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === 'AbortError' || error.name === 'TimeoutError')
    ) {
      return { kind: 'error', errorCode: 'timeout' };
    }
    if (isRedirectError(error)) return { kind: 'error', errorCode: 'substack_redirect_blocked' };
    return { kind: 'error', errorCode: 'network_error' };
  }
}

async function classifySubstackProfileResponse(
  result: ProfileFetchResult
): Promise<SubstackCredentialTestResult> {
  if (result.kind === 'error') {
    return { status: 'error', errorCode: result.errorCode };
  }
  const { response } = result;
  if (response.status === 401) {
    return { status: 'expired' };
  }
  if (response.status === 403) {
    return { status: 'error', errorCode: 'substack_forbidden' };
  }
  if (!response.ok) {
    return { status: 'error', errorCode: `http_${response.status}` };
  }
  const profile = parseSubstackProfile(await readJsonUnknown(response));
  return { status: 'healthy', ...profile, totpVerified: false };
}

function reauthFailureResult(failure: SubstackReauthFailure): SubstackCredentialTestResult {
  switch (failure.kind) {
    case 'fetch_failed':
      return { status: 'error', errorCode: failure.errorCode };
    case 'http':
      if (failure.status === 401) return { status: 'expired' };
      if (failure.status === 403) return { status: 'error', errorCode: 'substack_forbidden' };
      if (failure.status === 429) return { status: 'error', errorCode: 'rate_limited' };
      return { status: 'error', errorCode: `http_${failure.status}` };
    case 'method_unsupported':
      return { status: 'error', errorCode: 'substack_reauth_method_unsupported' };
    case 'error_payload':
      return { status: 'error', errorCode: 'substack_reauth_rejected' };
    case 'incomplete':
      return { status: 'error', errorCode: 'substack_reauth_incomplete' };
    case 'invalid_totp_secret':
      return { status: 'error', errorCode: 'substack_totp_invalid' };
    case 'low_time':
      return { status: 'error', errorCode: 'timeout' };
  }
}

function parseFailureResult(
  reason: 'invalid_material' | 'invalid_totp'
): SubstackCredentialTestResult {
  return reason === 'invalid_totp'
    ? { status: 'error', errorCode: 'substack_totp_invalid' }
    : { status: 'error', errorCode: 'credential_invalid' };
}

function parseSubstackProfile(payload: unknown): { handle: string | null; name: string | null } {
  if (!isRecord(payload)) {
    return { handle: null, name: null };
  }
  const profile = isRecord(payload.user) ? payload.user : payload;
  return {
    handle: asNonEmptyString(profile.handle),
    name: asNonEmptyString(profile.name),
  };
}

async function readJsonUnknown(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isRedirectError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (/redirect/i.test(error.message)) return true;
  return error.cause instanceof Error && /redirect/i.test(error.cause.message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
