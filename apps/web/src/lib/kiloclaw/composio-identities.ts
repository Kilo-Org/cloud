import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { decryptWithSymmetricKey, encryptWithSymmetricKey } from '@/lib/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import { withKiloclawProvisionContextLock } from '@/lib/kiloclaw/provision-lock';
import {
  getComposioAgentIdentity,
  resolveComposioConsumerProject,
  signupComposioAgentIdentity,
  type ComposioAgentIdentity,
} from '@/lib/kiloclaw/composio-client';
import {
  kiloclaw_composio_identities,
  type KiloClawComposioIdentity,
  type KiloClawComposioIdentityOwnerType,
  type NewKiloClawComposioIdentity,
} from '@kilocode/db/schema';

export type ComposioOwnerScope =
  | { ownerType: 'user'; userId: string }
  | { ownerType: 'organization_user'; userId: string; organizationId: string };

export type DecryptedComposioIdentity = {
  row: KiloClawComposioIdentity;
  agentKey: string;
  userApiKey: string;
  apiKey: string | null;
  org: string;
  consumerUserId: string;
};

function requireComposioEncryptionKey(): string {
  if (!BYOK_ENCRYPTION_KEY) {
    throw new Error('BYOK_ENCRYPTION_KEY is not configured');
  }
  return BYOK_ENCRYPTION_KEY;
}

function ownerScopeLockKey(scope: ComposioOwnerScope): string {
  if (scope.ownerType === 'user') return `kiloclaw-composio:user:${scope.userId}`;
  return `kiloclaw-composio:organization-user:${scope.organizationId}:${scope.userId}`;
}

export function composioConsumerUserId(scope: ComposioOwnerScope): string {
  if (scope.ownerType === 'user') return `kiloclaw:user:${scope.userId}`;
  return `kiloclaw:org-user:${scope.organizationId}:${scope.userId}`;
}

function scopeWhere(scope: ComposioOwnerScope) {
  if (scope.ownerType === 'user') {
    return and(
      eq(
        kiloclaw_composio_identities.owner_type,
        'user' satisfies KiloClawComposioIdentityOwnerType
      ),
      eq(kiloclaw_composio_identities.user_id, scope.userId),
      isNull(kiloclaw_composio_identities.organization_id),
      isNull(kiloclaw_composio_identities.revoked_at)
    );
  }

  return and(
    eq(
      kiloclaw_composio_identities.owner_type,
      'organization_user' satisfies KiloClawComposioIdentityOwnerType
    ),
    eq(kiloclaw_composio_identities.user_id, scope.userId),
    eq(kiloclaw_composio_identities.organization_id, scope.organizationId),
    isNull(kiloclaw_composio_identities.revoked_at)
  );
}

async function findActiveComposioIdentity(
  scope: ComposioOwnerScope
): Promise<KiloClawComposioIdentity | null> {
  const [row] = await db
    .select()
    .from(kiloclaw_composio_identities)
    .where(scopeWhere(scope))
    .limit(1);
  return row ?? null;
}

function decryptComposioIdentity(row: KiloClawComposioIdentity): DecryptedComposioIdentity {
  const encryptionKey = requireComposioEncryptionKey();
  return {
    row,
    agentKey: decryptWithSymmetricKey(row.composio_agent_key_encrypted, encryptionKey),
    userApiKey: decryptWithSymmetricKey(row.composio_user_api_key_encrypted, encryptionKey),
    apiKey: row.composio_api_key_encrypted
      ? decryptWithSymmetricKey(row.composio_api_key_encrypted, encryptionKey)
      : null,
    org: row.composio_org_id,
    consumerUserId: row.composio_consumer_user_id ?? composioConsumerUserId(scopeFromRow(row)),
  };
}

function scopeFromRow(row: KiloClawComposioIdentity): ComposioOwnerScope {
  if (row.owner_type === 'user') return { ownerType: 'user', userId: row.user_id };
  if (!row.organization_id) {
    throw new Error('Composio organization-user identity is missing organization_id');
  }
  return {
    ownerType: 'organization_user',
    userId: row.user_id,
    organizationId: row.organization_id,
  };
}

function encryptComposioIdentityCredentials(
  scope: ComposioOwnerScope,
  identity: ComposioAgentIdentity
): NewKiloClawComposioIdentity {
  const encryptionKey = requireComposioEncryptionKey();
  return {
    owner_type: scope.ownerType,
    user_id: scope.userId,
    organization_id: scope.ownerType === 'organization_user' ? scope.organizationId : null,
    composio_agent_key_encrypted: encryptWithSymmetricKey(identity.agent_key, encryptionKey),
    composio_user_api_key_encrypted: encryptWithSymmetricKey(
      identity.composio.user_api_key,
      encryptionKey
    ),
    composio_api_key_encrypted: identity.composio.api_key
      ? encryptWithSymmetricKey(identity.composio.api_key, encryptionKey)
      : null,
    composio_org_id: identity.composio.org_id,
    composio_org_name: identity.slug,
    composio_agent_email: identity.email,
  };
}

async function resolveComposioIdentityContext(identity: ComposioAgentIdentity) {
  const consumerProject = await resolveComposioConsumerProject({
    userApiKey: identity.composio.user_api_key,
    orgId: identity.composio.org_id,
  });
  return {
    composio_project_id: consumerProject.project_nano_id,
    composio_consumer_user_id: consumerProject.consumer_user_id,
  };
}

async function encryptComposioIdentity(
  scope: ComposioOwnerScope,
  identity: ComposioAgentIdentity
): Promise<NewKiloClawComposioIdentity> {
  return {
    ...encryptComposioIdentityCredentials(scope, identity),
    ...(await resolveComposioIdentityContext(identity)),
  };
}

function needsComposioIdentityRefresh(row: KiloClawComposioIdentity): boolean {
  return (
    !row.composio_project_id ||
    !row.composio_consumer_user_id ||
    row.composio_consumer_user_id.startsWith('kiloclaw:')
  );
}

async function insertPendingComposioIdentity(
  values: NewKiloClawComposioIdentity
): Promise<KiloClawComposioIdentity> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const [inserted] = await db.insert(kiloclaw_composio_identities).values(values).returning();
      if (inserted) return inserted;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Failed to store managed Composio identity');
}

export async function getActiveManagedComposioIdentity(
  scope: ComposioOwnerScope
): Promise<DecryptedComposioIdentity | null> {
  const row = await findActiveComposioIdentity(scope);
  return row ? decryptComposioIdentity(row) : null;
}

export async function ensureManagedComposioIdentity(
  scope: ComposioOwnerScope
): Promise<DecryptedComposioIdentity> {
  return await withKiloclawProvisionContextLock(ownerScopeLockKey(scope), async () => {
    const existing = await findActiveComposioIdentity(scope);
    if (existing) {
      const decrypted = decryptComposioIdentity(existing);
      if (!needsComposioIdentityRefresh(existing)) return decrypted;

      const refreshed = await getComposioAgentIdentity(decrypted.agentKey);
      const [updated] = await db
        .update(kiloclaw_composio_identities)
        .set(await encryptComposioIdentity(scope, refreshed))
        .where(eq(kiloclaw_composio_identities.id, existing.id))
        .returning();
      return decryptComposioIdentity(updated);
    }

    requireComposioEncryptionKey();
    const identity = await signupComposioAgentIdentity();
    const insertedPending = await insertPendingComposioIdentity(
      encryptComposioIdentityCredentials(scope, identity)
    );
    const [updated] = await db
      .update(kiloclaw_composio_identities)
      .set(await resolveComposioIdentityContext(identity))
      .where(eq(kiloclaw_composio_identities.id, insertedPending.id))
      .returning();
    if (!updated) {
      throw new Error('Failed to resolve managed Composio identity context');
    }
    return decryptComposioIdentity(updated);
  });
}
