import { eq } from 'drizzle-orm';
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

const SUBSTACK_PROFILE_TIMEOUT_MS = 15_000;
const SUBSTACK_COM_ORIGIN = 'https://substack.com';

export type SubstackCredentialTestResult =
  | { status: 'healthy'; handle: string | null; name: string | null }
  | { status: 'expired' }
  | { status: 'error'; errorCode: string };

export function cookieFromCredential(material: string): string | null {
  const trimmed = material.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed) && typeof parsed.sid === 'string' && parsed.sid) {
        return `connect.sid=${parsed.sid}`;
      }
      if (isRecord(parsed) && typeof parsed.cookie === 'string' && parsed.cookie) {
        return parsed.cookie;
      }
    } catch {
      return null;
    }
    return null;
  }
  return trimmed.includes('=') ? trimmed : `connect.sid=${trimmed}`;
}

export function getSubstackPublicationUrl(): string {
  return (
    getEnvVariable('SUBSTACK_PUBLICATION_URL').trim().replace(/\/$/, '') ||
    USER_DELETION_DEFAULT_SUBSTACK_PUBLICATION_URL
  );
}

export async function testSubstackCredentialMaterial(
  material: string
): Promise<SubstackCredentialTestResult> {
  const publication = getSubstackPublicationUrl();

  const cookie = cookieFromCredential(material);
  if (!cookie) {
    return { status: 'error', errorCode: 'credential_invalid' };
  }

  const profileUrl = `${publication}/api/v1/user/profile/self`;
  const first = await fetchSubstackProfile(profileUrl, cookie);
  if (
    first.kind === 'response' &&
    first.response.status === 404 &&
    publication !== SUBSTACK_COM_ORIGIN
  ) {
    return classifySubstackProfileResponse(
      await fetchSubstackProfile(`${SUBSTACK_COM_ORIGIN}/api/v1/user/profile/self`, cookie)
    );
  }
  return classifySubstackProfileResponse(first);
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
  return testSubstackCredentialMaterial(material);
}

export async function replaceSubstackCredential(params: {
  material: string;
  actorKiloUserId: string;
}): Promise<void> {
  const encrypted = encryptDeletionCredential(params.material);
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
  updatedAt: string | null;
  updatedByKiloUserId: string | null;
}> {
  const [row] = await db
    .select({
      updated_at: user_deletion_provider_credentials.updated_at,
      updated_by_kilo_user_id: user_deletion_provider_credentials.updated_by_kilo_user_id,
    })
    .from(user_deletion_provider_credentials)
    .where(
      eq(user_deletion_provider_credentials.provider_scope, UserDeletionProviderScope.Substack)
    )
    .limit(1);
  if (!row) {
    return { configured: false, updatedAt: null, updatedByKiloUserId: null };
  }
  return {
    configured: true,
    updatedAt: new Date(row.updated_at).toISOString(),
    updatedByKiloUserId: row.updated_by_kilo_user_id,
  };
}

type ProfileFetchResult =
  | { kind: 'response'; response: Response }
  | { kind: 'error'; errorCode: string };

async function fetchSubstackProfile(url: string, cookie: string): Promise<ProfileFetchResult> {
  try {
    const response = await fetch(url, {
      headers: { Cookie: cookie, Accept: 'application/json' },
      signal: AbortSignal.timeout(SUBSTACK_PROFILE_TIMEOUT_MS),
    });
    return { kind: 'response', response };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { kind: 'error', errorCode: 'timeout' };
    }
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
  if (response.status === 401 || response.status === 403) {
    return { status: 'expired' };
  }
  if (!response.ok) {
    return { status: 'error', errorCode: `http_${response.status}` };
  }
  return { status: 'healthy', ...parseSubstackProfile(await readJsonUnknown(response)) };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
