import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { decryptWithSymmetricKey, encryptWithSymmetricKey } from '@/lib/encryption';
import { COMPOSIO_MANAGED_IDENTITY_ENCRYPTION_KEY } from '@/lib/config.server';
import { withKiloclawProvisionContextLock } from '@/lib/kiloclaw/provision-lock';
import {
  getComposioAgentIdentity,
  signupComposioAgentIdentity,
  type ComposioAgentIdentity,
} from '@/lib/kiloclaw/composio-client';
import {
  kiloclaw_composio_identities,
  type KiloClawComposioIdentity,
  type KiloClawComposioIdentityOwnerType,
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
  if (!COMPOSIO_MANAGED_IDENTITY_ENCRYPTION_KEY) {
    throw new Error('COMPOSIO_MANAGED_IDENTITY_ENCRYPTION_KEY is not configured');
  }
  return COMPOSIO_MANAGED_IDENTITY_ENCRYPTION_KEY;
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

function encryptComposioIdentity(scope: ComposioOwnerScope, identity: ComposioAgentIdentity) {
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
    composio_project_id: identity.composio.project_id,
    composio_consumer_user_id: composioConsumerUserId(scope),
    composio_agent_email: identity.email,
  };
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
      if (decrypted.apiKey) return decrypted;

      const refreshed = await getComposioAgentIdentity(decrypted.agentKey);
      const [updated] = await db
        .update(kiloclaw_composio_identities)
        .set(encryptComposioIdentity(scope, refreshed))
        .where(eq(kiloclaw_composio_identities.id, existing.id))
        .returning();
      return decryptComposioIdentity(updated);
    }

    const identity = await signupComposioAgentIdentity();
    const [inserted] = await db
      .insert(kiloclaw_composio_identities)
      .values(encryptComposioIdentity(scope, identity))
      .returning();
    return decryptComposioIdentity(inserted);
  });
}
