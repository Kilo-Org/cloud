import { createPrivateKey, createPublicKey } from 'node:crypto';
import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import {
  kilocode_users,
  organization_memberships,
  platform_access_token_credentials,
  platform_integrations,
} from '@kilocode/db/schema';
import { decryptKeyedEnvelope, parseKeyedEnvelope } from '@kilocode/encryption';
import {
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_ENVELOPE_SCHEME,
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE,
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM,
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_PROVIDER_CREDENTIAL_TYPE,
  buildBitbucketOrganizationCredentialLockKey,
  buildBitbucketWorkspaceAccessTokenAad,
  hasBitbucketAccessTokenFamilyPrefix,
  hasRequiredBitbucketWorkspaceAccessTokenScopes,
  normalizeBitbucketWorkspaceAccessTokenScopes,
  type BitbucketWorkspaceAccessTokenInvalidationReason,
} from '@kilocode/worker-utils/bitbucket-workspace-access-token';
import { and, eq, exists, isNull, lt, or, sql } from 'drizzle-orm';
import { normalizeBitbucketUuid } from './bitbucket-url.js';

export type BitbucketWorkspaceAccessTokenAuthorizationCandidate = {
  integrationId: string;
  credentialId: string;
  organizationId: string;
  ownedByUserId: string | null;
  platform: string;
  integrationType: string;
  integrationStatus: string | null;
  installationId: string | null;
  accountId: string | null;
  accountLogin: string | null;
  authInvalidAt: string | null;
  credentialPlatform: string;
  credentialIntegrationType: string;
  tokenEncrypted: string;
  providerCredentialType: string;
  providerScopes: string[];
  providerVerifiedAt: string;
  credentialVersion: number;
  lastValidatedAt: string;
};

export type BitbucketWorkspaceAccessTokenAuthorizationFence = {
  organizationId: string;
  integrationId: string;
  credentialId: string;
  credentialVersion: number;
};

export type BitbucketWorkspaceAccessTokenAuthorizationStore = {
  findAuthorization(input: {
    userId: string;
    organizationId: string;
  }): Promise<BitbucketWorkspaceAccessTokenAuthorizationCandidate | null>;
  markUsed(fence: BitbucketWorkspaceAccessTokenAuthorizationFence, at: string): Promise<boolean>;
  invalidate(
    fence: BitbucketWorkspaceAccessTokenAuthorizationFence,
    reason: BitbucketWorkspaceAccessTokenInvalidationReason,
    at: string
  ): Promise<boolean>;
};

export type BitbucketWorkspaceAccessTokenAuthorization = {
  status: 'available';
  token: string;
  organizationId: string;
  integrationId: string;
  credentialId: string;
  credentialVersion: number;
  providerScopes: string[];
  workspace: { uuid: string; slug: string };
};

export type BitbucketWorkspaceAccessTokenAuthorizationResult =
  | BitbucketWorkspaceAccessTokenAuthorization
  | { status: 'invalid_request' }
  | { status: 'not_connected' }
  | { status: 'reconnect_required' }
  | { status: 'temporarily_unavailable' };

type Secret = SecretsStoreSecret | string | undefined;
type AuthorizationEnv = Pick<CloudflareEnv, 'HYPERDRIVE'> & {
  BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID?: Secret;
  BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY?: Secret;
  BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PRIVATE_KEY?: Secret;
};
type AuthorizationDependencies = {
  store?: BitbucketWorkspaceAccessTokenAuthorizationStore;
  now?: () => Date;
};
type WorkerTransaction = Parameters<Parameters<WorkerDb['transaction']>[0]>[0];
type AuthorizationDb = WorkerDb | WorkerTransaction;

function normalizeOrganizationId(value: string): string | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return null;
  }
  return value.toLowerCase();
}

function isCanonicalWorkspaceSlug(value: string): boolean {
  return value.length <= 255 && /^[A-Za-z0-9_.-]+$/.test(value) && value !== '.' && value !== '..';
}

function isValidTimestamp(value: string): boolean {
  return Number.isFinite(new Date(value).getTime());
}

function hasVisibleAsciiOnly(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

function authorizationFence(
  candidate: BitbucketWorkspaceAccessTokenAuthorizationCandidate
): BitbucketWorkspaceAccessTokenAuthorizationFence {
  return {
    organizationId: candidate.organizationId,
    integrationId: candidate.integrationId,
    credentialId: candidate.credentialId,
    credentialVersion: candidate.credentialVersion,
  };
}

function getVerifiedCredentialScopes(
  candidate: BitbucketWorkspaceAccessTokenAuthorizationCandidate
): string[] | null {
  const normalizedScopes = normalizeBitbucketWorkspaceAccessTokenScopes(
    candidate.providerScopes.join(' ')
  );
  const hasVerifiedProfile =
    candidate.credentialPlatform === BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM &&
    candidate.credentialIntegrationType === BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE &&
    candidate.providerCredentialType ===
      BITBUCKET_WORKSPACE_ACCESS_TOKEN_PROVIDER_CREDENTIAL_TYPE &&
    isValidTimestamp(candidate.providerVerifiedAt) &&
    isValidTimestamp(candidate.lastValidatedAt) &&
    normalizedScopes.length === candidate.providerScopes.length &&
    normalizedScopes.every((scope, index) => scope === candidate.providerScopes[index]) &&
    hasRequiredBitbucketWorkspaceAccessTokenScopes(normalizedScopes);

  return hasVerifiedProfile ? normalizedScopes : null;
}

function hasActiveParent(
  candidate: BitbucketWorkspaceAccessTokenAuthorizationCandidate,
  organizationId: string
): boolean {
  return (
    candidate.organizationId === organizationId &&
    candidate.ownedByUserId === null &&
    candidate.platform === BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM &&
    candidate.integrationType === BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE &&
    candidate.integrationStatus === 'active' &&
    candidate.installationId === null &&
    candidate.authInvalidAt === null
  );
}

export function buildBitbucketWorkspaceAccessTokenAuthorizationQuery(
  db: WorkerDb,
  input: { userId: string; organizationId: string }
) {
  const currentOrganizationMembership = exists(
    db
      .select({ id: organization_memberships.id })
      .from(organization_memberships)
      .where(
        and(
          eq(organization_memberships.organization_id, input.organizationId),
          eq(organization_memberships.kilo_user_id, input.userId)
        )
      )
  );

  return db
    .select({
      integrationId: platform_integrations.id,
      credentialId: platform_access_token_credentials.id,
      organizationId: platform_integrations.owned_by_organization_id,
      ownedByUserId: platform_integrations.owned_by_user_id,
      platform: platform_integrations.platform,
      integrationType: platform_integrations.integration_type,
      integrationStatus: platform_integrations.integration_status,
      installationId: platform_integrations.platform_installation_id,
      accountId: platform_integrations.platform_account_id,
      accountLogin: platform_integrations.platform_account_login,
      authInvalidAt: platform_integrations.auth_invalid_at,
      credentialPlatform: platform_access_token_credentials.platform,
      credentialIntegrationType: platform_access_token_credentials.integration_type,
      tokenEncrypted: platform_access_token_credentials.token_encrypted,
      providerCredentialType: platform_access_token_credentials.provider_credential_type,
      providerScopes: platform_access_token_credentials.provider_scopes,
      providerVerifiedAt: platform_access_token_credentials.provider_verified_at,
      credentialVersion: platform_access_token_credentials.credential_version,
      lastValidatedAt: platform_access_token_credentials.last_validated_at,
    })
    .from(platform_integrations)
    .innerJoin(
      platform_access_token_credentials,
      and(
        eq(platform_access_token_credentials.platform_integration_id, platform_integrations.id),
        eq(platform_access_token_credentials.platform, platform_integrations.platform),
        eq(
          platform_access_token_credentials.integration_type,
          platform_integrations.integration_type
        ),
        eq(
          platform_access_token_credentials.owned_by_organization_id,
          platform_integrations.owned_by_organization_id
        )
      )
    )
    .innerJoin(
      kilocode_users,
      and(eq(kilocode_users.id, input.userId), isNull(kilocode_users.blocked_reason))
    )
    .where(
      and(
        eq(platform_integrations.owned_by_organization_id, input.organizationId),
        isNull(platform_integrations.owned_by_user_id),
        eq(platform_integrations.platform, BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM),
        eq(
          platform_integrations.integration_type,
          BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE
        ),
        or(currentOrganizationMembership, eq(kilocode_users.is_admin, true))
      )
    )
    .limit(1);
}

export function withBitbucketWorkspaceAccessTokenOrganizationLock<T>(
  db: Pick<WorkerDb, 'transaction'>,
  organizationId: string,
  operation: (tx: WorkerTransaction) => Promise<T>
): Promise<T> {
  return db.transaction(async tx => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${buildBitbucketOrganizationCredentialLockKey(organizationId)}, 0))`
    );
    return operation(tx);
  });
}

export function buildBitbucketWorkspaceAccessTokenCredentialGenerationQuery(
  db: AuthorizationDb,
  fence: BitbucketWorkspaceAccessTokenAuthorizationFence
) {
  return db
    .select({ id: platform_access_token_credentials.id })
    .from(platform_access_token_credentials)
    .where(
      and(
        eq(platform_access_token_credentials.id, fence.credentialId),
        eq(platform_access_token_credentials.owned_by_organization_id, fence.organizationId),
        eq(platform_access_token_credentials.platform_integration_id, fence.integrationId),
        eq(platform_access_token_credentials.platform, BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM),
        eq(
          platform_access_token_credentials.integration_type,
          BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE
        ),
        eq(platform_access_token_credentials.credential_version, fence.credentialVersion)
      )
    )
    .limit(1);
}

export function buildBitbucketWorkspaceAccessTokenMarkUsedQuery(
  db: AuthorizationDb,
  fence: BitbucketWorkspaceAccessTokenAuthorizationFence,
  at: string
) {
  return db
    .update(platform_access_token_credentials)
    .set({ last_used_at: at })
    .where(
      and(
        eq(platform_access_token_credentials.id, fence.credentialId),
        eq(platform_access_token_credentials.owned_by_organization_id, fence.organizationId),
        eq(platform_access_token_credentials.platform_integration_id, fence.integrationId),
        eq(platform_access_token_credentials.credential_version, fence.credentialVersion),
        or(
          isNull(platform_access_token_credentials.last_used_at),
          lt(platform_access_token_credentials.last_used_at, at)
        )
      )
    )
    .returning({ id: platform_access_token_credentials.id });
}

export function buildBitbucketWorkspaceAccessTokenInvalidationQuery(
  db: AuthorizationDb,
  fence: BitbucketWorkspaceAccessTokenAuthorizationFence,
  reason: BitbucketWorkspaceAccessTokenInvalidationReason,
  at: string
) {
  return db
    .update(platform_integrations)
    .set({ auth_invalid_at: at, auth_invalid_reason: reason })
    .where(
      and(
        eq(platform_integrations.id, fence.integrationId),
        eq(platform_integrations.owned_by_organization_id, fence.organizationId),
        isNull(platform_integrations.owned_by_user_id),
        eq(platform_integrations.platform, BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM),
        eq(
          platform_integrations.integration_type,
          BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE
        ),
        isNull(platform_integrations.auth_invalid_at)
      )
    )
    .returning({ id: platform_integrations.id });
}

class DrizzleBitbucketWorkspaceAccessTokenAuthorizationStore implements BitbucketWorkspaceAccessTokenAuthorizationStore {
  constructor(private db: WorkerDb) {}

  async findAuthorization(input: {
    userId: string;
    organizationId: string;
  }): Promise<BitbucketWorkspaceAccessTokenAuthorizationCandidate | null> {
    const [candidate] = await buildBitbucketWorkspaceAccessTokenAuthorizationQuery(this.db, input);
    if (!candidate?.organizationId) return null;
    return { ...candidate, organizationId: candidate.organizationId };
  }

  async markUsed(
    fence: BitbucketWorkspaceAccessTokenAuthorizationFence,
    at: string
  ): Promise<boolean> {
    const updated = await buildBitbucketWorkspaceAccessTokenMarkUsedQuery(this.db, fence, at);
    return updated.length === 1;
  }

  async invalidate(
    fence: BitbucketWorkspaceAccessTokenAuthorizationFence,
    reason: BitbucketWorkspaceAccessTokenInvalidationReason,
    at: string
  ): Promise<boolean> {
    return withBitbucketWorkspaceAccessTokenOrganizationLock(
      this.db,
      fence.organizationId,
      async tx => {
        const [currentGeneration] =
          await buildBitbucketWorkspaceAccessTokenCredentialGenerationQuery(tx, fence);
        if (!currentGeneration) return false;

        const updated = await buildBitbucketWorkspaceAccessTokenInvalidationQuery(
          tx,
          fence,
          reason,
          at
        );
        return updated.length === 1;
      }
    );
  }
}

async function resolveSecret(secret: Secret): Promise<string | null> {
  if (!secret) return null;
  const value = typeof secret === 'string' ? secret : await secret.get();
  return value || null;
}

function temporarilyUnavailable(reason: string): { status: 'temporarily_unavailable' } {
  console.warn('[bitbucket-workspace-token] Authorization unavailable', { reason });
  return { status: 'temporarily_unavailable' };
}

export class BitbucketWorkspaceAccessTokenAuthorizationService {
  constructor(
    private env: AuthorizationEnv,
    private dependencies: AuthorizationDependencies = {}
  ) {}

  async getAuthorization(input: {
    userId: string;
    orgId?: string;
  }): Promise<BitbucketWorkspaceAccessTokenAuthorizationResult> {
    const organizationId = input.orgId ? normalizeOrganizationId(input.orgId) : null;
    if (!organizationId) return { status: 'invalid_request' };
    const store = this.getStore();
    if (!store) return temporarilyUnavailable('store_missing');

    let candidate: BitbucketWorkspaceAccessTokenAuthorizationCandidate | null;
    try {
      candidate = await store.findAuthorization({
        userId: input.userId,
        organizationId,
      });
    } catch {
      return temporarilyUnavailable('lookup_failed');
    }
    if (!candidate) return { status: 'not_connected' };
    const providerScopes = getVerifiedCredentialScopes(candidate);
    if (!hasActiveParent(candidate, organizationId) || !providerScopes) {
      return { status: 'reconnect_required' };
    }

    const workspaceUuid = candidate.accountId ? normalizeBitbucketUuid(candidate.accountId) : null;
    if (
      !workspaceUuid ||
      workspaceUuid !== candidate.accountId ||
      !candidate.accountLogin ||
      !isCanonicalWorkspaceSlug(candidate.accountLogin) ||
      !Number.isInteger(candidate.credentialVersion) ||
      candidate.credentialVersion <= 0 ||
      candidate.tokenEncrypted === ''
    ) {
      return { status: 'reconnect_required' };
    }

    const currentTime = (this.dependencies.now ?? (() => new Date()))();
    const decrypted = await this.decrypt(candidate);
    if (decrypted.status === 'temporarily_unavailable') return decrypted;
    if (decrypted.status === 'unreadable') {
      await this.invalidateWithStore(
        store,
        candidate,
        'encryption_unreadable',
        currentTime.toISOString()
      );
      return { status: 'reconnect_required' };
    }

    try {
      await store.markUsed(authorizationFence(candidate), currentTime.toISOString());
    } catch {
      return temporarilyUnavailable('mark_used_failed');
    }
    return {
      status: 'available',
      token: decrypted.token,
      organizationId: candidate.organizationId,
      integrationId: candidate.integrationId,
      credentialId: candidate.credentialId,
      credentialVersion: candidate.credentialVersion,
      providerScopes,
      workspace: { uuid: workspaceUuid, slug: candidate.accountLogin },
    };
  }

  async invalidateAuthorization(
    authorization: BitbucketWorkspaceAccessTokenAuthorization,
    reason: BitbucketWorkspaceAccessTokenInvalidationReason
  ): Promise<void> {
    const store = this.getStore();
    if (!store) return;
    const at = (this.dependencies.now ?? (() => new Date()))().toISOString();
    try {
      await store.invalidate(
        {
          organizationId: authorization.organizationId,
          integrationId: authorization.integrationId,
          credentialId: authorization.credentialId,
          credentialVersion: authorization.credentialVersion,
        },
        reason,
        at
      );
    } catch {
      return;
    }
  }

  private getStore(): BitbucketWorkspaceAccessTokenAuthorizationStore | null {
    if (this.dependencies.store) return this.dependencies.store;
    if (!this.env.HYPERDRIVE) return null;
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString, { statement_timeout: 10_000 });
    return new DrizzleBitbucketWorkspaceAccessTokenAuthorizationStore(db);
  }

  private async decrypt(
    candidate: BitbucketWorkspaceAccessTokenAuthorizationCandidate
  ): Promise<
    | { status: 'available'; token: string }
    | { status: 'temporarily_unavailable' }
    | { status: 'unreadable' }
  > {
    let keyId: string | null;
    let encodedPublicKey: string | null;
    let encodedPrivateKey: string | null;
    try {
      [keyId, encodedPublicKey, encodedPrivateKey] = await Promise.all([
        resolveSecret(this.env.BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID),
        resolveSecret(this.env.BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY),
        resolveSecret(this.env.BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PRIVATE_KEY),
      ]);
    } catch {
      return temporarilyUnavailable('secret_resolution_failed');
    }
    if (!keyId || !encodedPublicKey || !encodedPrivateKey) {
      return temporarilyUnavailable('secret_missing');
    }

    let privateKeyPem: string;
    try {
      const publicKeyPem = Buffer.from(encodedPublicKey, 'base64').toString('utf8');
      privateKeyPem = Buffer.from(encodedPrivateKey, 'base64').toString('utf8');
      if (publicKeyPem.includes('PRIVATE KEY')) {
        return temporarilyUnavailable('public_key_contains_private_key');
      }
      const publicKey = createPublicKey(publicKeyPem);
      const privateKey = createPrivateKey(privateKeyPem);
      if (publicKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyType !== 'rsa') {
        return temporarilyUnavailable('non_rsa_key_material');
      }
      const configuredPublicKey = publicKey.export({ type: 'spki', format: 'der' });
      const derivedPublicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
      if (!configuredPublicKey.equals(derivedPublicKey)) {
        return temporarilyUnavailable('key_pair_mismatch');
      }
    } catch {
      return temporarilyUnavailable('key_material_invalid');
    }

    let envelope;
    try {
      envelope = parseKeyedEnvelope(
        candidate.tokenEncrypted,
        BITBUCKET_WORKSPACE_ACCESS_TOKEN_ENVELOPE_SCHEME
      );
    } catch {
      return { status: 'unreadable' };
    }
    if (envelope.keyId !== keyId) return temporarilyUnavailable('envelope_key_mismatch');

    let token: string;
    try {
      token = decryptKeyedEnvelope(
        candidate.tokenEncrypted,
        BITBUCKET_WORKSPACE_ACCESS_TOKEN_ENVELOPE_SCHEME,
        { active: { keyId, privateKeyPem } },
        buildBitbucketWorkspaceAccessTokenAad({
          organizationId: candidate.organizationId,
          integrationId: candidate.integrationId,
          credentialId: candidate.credentialId,
          credentialVersion: candidate.credentialVersion,
        })
      );
    } catch {
      return { status: 'unreadable' };
    }
    if (!hasBitbucketAccessTokenFamilyPrefix(token) || !hasVisibleAsciiOnly(token)) {
      return { status: 'unreadable' };
    }
    return { status: 'available', token };
  }

  private async invalidateWithStore(
    store: BitbucketWorkspaceAccessTokenAuthorizationStore,
    candidate: BitbucketWorkspaceAccessTokenAuthorizationCandidate,
    reason: BitbucketWorkspaceAccessTokenInvalidationReason,
    at: string
  ): Promise<void> {
    try {
      await store.invalidate(authorizationFence(candidate), reason, at);
    } catch {
      return;
    }
  }
}
