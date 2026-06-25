import 'server-only';

import { createPublicKey, randomUUID } from 'node:crypto';
import {
  BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID,
  BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY,
} from '@/lib/config.server';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { INTEGRATION_STATUS } from '@/lib/integrations/core/constants';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { encryptKeyedEnvelope } from '@kilocode/encryption';
import {
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_ENVELOPE_SCHEME,
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE,
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM,
  buildBitbucketWorkspaceAccessTokenAad,
  getUnexpectedBitbucketWorkspaceAccessTokenScopes,
} from '@kilocode/worker-utils/bitbucket-workspace-access-token';
import { platform_access_token_credentials, platform_integrations } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  validateBitbucketWorkspaceAccessToken,
  type BitbucketWorkspaceAccessTokenRepository,
  type BitbucketWorkspaceAccessTokenValidation,
} from './workspace-access-token-adapter';
import { BitbucketWorkspaceAccessTokenMetadataSchema } from './metadata';
import {
  BitbucketWorkspaceAccessTokenOrganizationAuthorizationError,
  lockBitbucketWorkspaceAccessTokenOrganization as acquireOrganizationCredentialLock,
  requireBitbucketWorkspaceAccessTokenOrganizationManager,
  type BitbucketWorkspaceAccessTokenAuthorizedActor as AuthorizedActor,
} from './workspace-access-token-organization-authorization';

const INITIAL_CREDENTIAL_VERSION = 1;

export type BitbucketWorkspaceAccessTokenCredentialErrorCode =
  | 'unauthorized'
  | 'invalid_organization_id'
  | 'organization_not_found'
  | 'not_connected'
  | 'credential_conflict'
  | 'encryption_failed';

const ERROR_MESSAGES: Record<BitbucketWorkspaceAccessTokenCredentialErrorCode, string> = {
  unauthorized: 'The current user cannot manage this organization integration',
  invalid_organization_id: 'The organization ID is invalid',
  organization_not_found: 'The organization was not found',
  not_connected: 'The Bitbucket organization integration was not found',
  credential_conflict: 'The Bitbucket credential changed during this operation',
  encryption_failed: 'Bitbucket credential encryption is unavailable',
};

export class BitbucketWorkspaceAccessTokenCredentialError extends Error {
  constructor(readonly code: BitbucketWorkspaceAccessTokenCredentialErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'BitbucketWorkspaceAccessTokenCredentialError';
  }
}

type CredentialEncryptionKey = {
  keyId: string;
  publicKeyPem: Buffer;
};

export type ConnectBitbucketWorkspaceAccessTokenInput = {
  organizationId: string;
  actorUserId: string;
  accessToken: string;
};

export type RotateBitbucketWorkspaceAccessTokenInput = {
  organizationId: string;
  actorUserId: string;
  integrationId: string;
  accessToken: string;
};

export type DisconnectBitbucketWorkspaceAccessTokenInput = {
  organizationId: string;
  actorUserId: string;
  integrationId: string;
};

export type BitbucketWorkspaceAccessTokenMutationResult = {
  integrationId: string;
  workspace: BitbucketWorkspaceAccessTokenValidation['workspace'];
  credentialVersion: number;
  repositoryCount: number;
  validatedAt: string;
  unexpectedScopes: string[];
};

function canonicalizeOrganizationId(value: string): string {
  const canonical = value.toLowerCase();
  if (value.trim() !== value || !z.uuid().safeParse(canonical).success) {
    throw new BitbucketWorkspaceAccessTokenCredentialError('invalid_organization_id');
  }
  return canonical;
}

function requireCredentialEncryptionKey(): CredentialEncryptionKey {
  const keyId = BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID;
  const encodedPublicKey = BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY;
  if (!keyId || keyId.trim() !== keyId || !encodedPublicKey) {
    throw new BitbucketWorkspaceAccessTokenCredentialError('encryption_failed');
  }

  const publicKeyPem = Buffer.from(encodedPublicKey, 'base64');
  try {
    if (publicKeyPem.toString('utf8').includes('PRIVATE KEY')) {
      throw new Error('Private key material is not allowed');
    }
    const publicKey = createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== 'rsa') {
      throw new Error('RSA public key is required');
    }
  } catch {
    throw new BitbucketWorkspaceAccessTokenCredentialError('encryption_failed');
  }

  return { keyId, publicKeyPem };
}

async function requireOrganizationManager(
  tx: DrizzleTransaction,
  organizationId: string,
  actorUserId: string
): Promise<AuthorizedActor> {
  try {
    return await requireBitbucketWorkspaceAccessTokenOrganizationManager(
      tx,
      organizationId,
      actorUserId
    );
  } catch (error) {
    if (error instanceof BitbucketWorkspaceAccessTokenOrganizationAuthorizationError) {
      throw new BitbucketWorkspaceAccessTokenCredentialError(error.code);
    }
    throw error;
  }
}

async function preauthorizeOrganizationManager(
  organizationId: string,
  actorUserId: string
): Promise<void> {
  await db.transaction(tx => requireOrganizationManager(tx, organizationId, actorUserId));
}

function encryptAccessToken(input: {
  accessToken: string;
  credentialId: string;
  integrationId: string;
  organizationId: string;
  credentialVersion: number;
}): string {
  const encryptionKey = requireCredentialEncryptionKey();
  try {
    return encryptKeyedEnvelope(
      input.accessToken,
      BITBUCKET_WORKSPACE_ACCESS_TOKEN_ENVELOPE_SCHEME,
      encryptionKey,
      buildBitbucketWorkspaceAccessTokenAad({
        credentialId: input.credentialId,
        integrationId: input.integrationId,
        organizationId: input.organizationId,
        credentialVersion: input.credentialVersion,
      })
    );
  } catch {
    throw new BitbucketWorkspaceAccessTokenCredentialError('encryption_failed');
  }
}

function cacheRepositories(repositories: BitbucketWorkspaceAccessTokenRepository[]) {
  return repositories.map(repository => ({
    id: repository.id,
    name: repository.name,
    full_name: repository.fullName,
    private: repository.private,
    default_branch: repository.defaultBranch,
  }));
}

function auditMessage(input: {
  action: 'connected' | 'rotated' | 'disconnected';
  integrationId: string;
  workspaceUuid: string;
  workspaceSlug: string;
}): string {
  return `Bitbucket Workspace Access Token ${input.action} (integration ${input.integrationId}, workspace ${input.workspaceUuid}, slug ${input.workspaceSlug})`;
}

async function writeAudit(input: {
  tx: DrizzleTransaction;
  actor: AuthorizedActor;
  organizationId: string;
  action: 'connected' | 'rotated' | 'disconnected';
  integrationId: string;
  workspaceUuid: string;
  workspaceSlug: string;
}): Promise<void> {
  await createAuditLog({
    tx: input.tx,
    action: 'organization.settings.change',
    actor_email: input.actor.email,
    actor_id: input.actor.id,
    actor_name: input.actor.name,
    organization_id: input.organizationId,
    message: auditMessage(input),
  });
}

export async function disconnectBitbucketWorkspaceAccessToken(
  input: DisconnectBitbucketWorkspaceAccessTokenInput
): Promise<{ integrationId: string }> {
  const organizationId = canonicalizeOrganizationId(input.organizationId);
  await preauthorizeOrganizationManager(organizationId, input.actorUserId);

  return db.transaction(async tx => {
    await acquireOrganizationCredentialLock(tx, organizationId);
    const actor = await requireOrganizationManager(tx, organizationId, input.actorUserId);
    const [integration] = await tx
      .select({
        id: platform_integrations.id,
        workspaceUuid: platform_integrations.platform_account_id,
        workspaceSlug: platform_integrations.platform_account_login,
      })
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.id, input.integrationId),
          eq(platform_integrations.owned_by_organization_id, organizationId),
          eq(platform_integrations.platform, BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM),
          eq(
            platform_integrations.integration_type,
            BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE
          )
        )
      )
      .for('update');
    if (!integration || !integration.workspaceUuid || !integration.workspaceSlug) {
      throw new BitbucketWorkspaceAccessTokenCredentialError('not_connected');
    }

    await writeAudit({
      tx,
      actor,
      organizationId,
      action: 'disconnected',
      integrationId: integration.id,
      workspaceUuid: integration.workspaceUuid,
      workspaceSlug: integration.workspaceSlug,
    });
    const [deleted] = await tx
      .delete(platform_integrations)
      .where(
        and(
          eq(platform_integrations.id, integration.id),
          eq(platform_integrations.owned_by_organization_id, organizationId),
          eq(platform_integrations.platform, BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM),
          eq(
            platform_integrations.integration_type,
            BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE
          )
        )
      )
      .returning({ id: platform_integrations.id });
    if (!deleted) {
      throw new BitbucketWorkspaceAccessTokenCredentialError('credential_conflict');
    }

    return { integrationId: integration.id };
  });
}

export async function rotateBitbucketWorkspaceAccessToken(
  input: RotateBitbucketWorkspaceAccessTokenInput
): Promise<BitbucketWorkspaceAccessTokenMutationResult> {
  const organizationId = canonicalizeOrganizationId(input.organizationId);
  await preauthorizeOrganizationManager(organizationId, input.actorUserId);
  const [observed] = await db
    .select({
      integrationId: platform_integrations.id,
      workspaceUuid: platform_integrations.platform_account_id,
      workspaceSlug: platform_integrations.platform_account_login,
      credentialId: platform_access_token_credentials.id,
      credentialVersion: platform_access_token_credentials.credential_version,
    })
    .from(platform_integrations)
    .innerJoin(
      platform_access_token_credentials,
      eq(platform_access_token_credentials.platform_integration_id, platform_integrations.id)
    )
    .where(
      and(
        eq(platform_integrations.id, input.integrationId),
        eq(platform_integrations.owned_by_organization_id, organizationId),
        eq(platform_integrations.platform, BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM),
        eq(
          platform_integrations.integration_type,
          BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE
        ),
        eq(platform_access_token_credentials.owned_by_organization_id, organizationId)
      )
    );
  if (!observed || !observed.workspaceUuid || !observed.workspaceSlug) {
    throw new BitbucketWorkspaceAccessTokenCredentialError('not_connected');
  }
  const observedWorkspaceUuid = observed.workspaceUuid;
  const observedWorkspaceSlug = observed.workspaceSlug;
  if (observed.credentialVersion >= 2_147_483_647) {
    throw new BitbucketWorkspaceAccessTokenCredentialError('credential_conflict');
  }

  const validation = await validateBitbucketWorkspaceAccessToken({
    expectedWorkspaceUuid: observedWorkspaceUuid,
    accessToken: input.accessToken,
  });
  const credentialVersion = observed.credentialVersion + 1;
  const validatedAt = new Date().toISOString();
  const tokenEncrypted = encryptAccessToken({
    accessToken: input.accessToken,
    credentialId: observed.credentialId,
    integrationId: observed.integrationId,
    organizationId,
    credentialVersion,
  });
  const metadata = BitbucketWorkspaceAccessTokenMetadataSchema.parse({
    displayName: validation.workspace.displayName,
  });
  const repositories = cacheRepositories(validation.repositories);

  return db.transaction(async tx => {
    await acquireOrganizationCredentialLock(tx, organizationId);
    const actor = await requireOrganizationManager(tx, organizationId, input.actorUserId);
    const [current] = await tx
      .select({
        integrationId: platform_integrations.id,
        workspaceUuid: platform_integrations.platform_account_id,
        workspaceSlug: platform_integrations.platform_account_login,
        credentialId: platform_access_token_credentials.id,
        credentialVersion: platform_access_token_credentials.credential_version,
      })
      .from(platform_integrations)
      .innerJoin(
        platform_access_token_credentials,
        eq(platform_access_token_credentials.platform_integration_id, platform_integrations.id)
      )
      .where(
        and(
          eq(platform_integrations.id, input.integrationId),
          eq(platform_integrations.owned_by_organization_id, organizationId),
          eq(platform_integrations.platform, BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM),
          eq(
            platform_integrations.integration_type,
            BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE
          ),
          eq(platform_access_token_credentials.owned_by_organization_id, organizationId)
        )
      )
      .for('update');
    if (!current) {
      throw new BitbucketWorkspaceAccessTokenCredentialError('not_connected');
    }
    if (
      current.credentialId !== observed.credentialId ||
      current.credentialVersion !== observed.credentialVersion ||
      current.workspaceUuid !== observedWorkspaceUuid ||
      current.workspaceSlug !== observedWorkspaceSlug
    ) {
      throw new BitbucketWorkspaceAccessTokenCredentialError('credential_conflict');
    }

    const [updatedCredential] = await tx
      .update(platform_access_token_credentials)
      .set({
        token_encrypted: tokenEncrypted,
        expires_at: null,
        provider_credential_type: validation.providerCredentialType,
        provider_scopes: validation.providerScopes,
        provider_verified_at: validatedAt,
        credential_version: credentialVersion,
        last_validated_at: validatedAt,
        updated_at: validatedAt,
      })
      .where(
        and(
          eq(platform_access_token_credentials.id, observed.credentialId),
          eq(platform_access_token_credentials.platform_integration_id, observed.integrationId),
          eq(platform_access_token_credentials.owned_by_organization_id, organizationId),
          eq(platform_access_token_credentials.credential_version, observed.credentialVersion)
        )
      )
      .returning({ id: platform_access_token_credentials.id });
    if (!updatedCredential) {
      throw new BitbucketWorkspaceAccessTokenCredentialError('credential_conflict');
    }

    const [updatedIntegration] = await tx
      .update(platform_integrations)
      .set({
        platform_account_login: validation.workspace.slug,
        metadata,
        repositories,
        repositories_synced_at: validatedAt,
        auth_invalid_at: null,
        auth_invalid_reason: null,
        updated_at: validatedAt,
      })
      .where(
        and(
          eq(platform_integrations.id, observed.integrationId),
          eq(platform_integrations.owned_by_organization_id, organizationId),
          eq(platform_integrations.platform, BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM),
          eq(
            platform_integrations.integration_type,
            BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE
          ),
          eq(platform_integrations.platform_account_id, observedWorkspaceUuid)
        )
      )
      .returning({ id: platform_integrations.id });
    if (!updatedIntegration) {
      throw new BitbucketWorkspaceAccessTokenCredentialError('credential_conflict');
    }

    await writeAudit({
      tx,
      actor,
      organizationId,
      action: 'rotated',
      integrationId: observed.integrationId,
      workspaceUuid: validation.workspace.uuid,
      workspaceSlug: validation.workspace.slug,
    });

    return {
      integrationId: observed.integrationId,
      workspace: validation.workspace,
      credentialVersion,
      repositoryCount: repositories.length,
      validatedAt,
      unexpectedScopes: getUnexpectedBitbucketWorkspaceAccessTokenScopes(validation.providerScopes),
    };
  });
}

export async function connectBitbucketWorkspaceAccessToken(
  input: ConnectBitbucketWorkspaceAccessTokenInput
): Promise<BitbucketWorkspaceAccessTokenMutationResult> {
  const organizationId = canonicalizeOrganizationId(input.organizationId);
  await preauthorizeOrganizationManager(organizationId, input.actorUserId);
  const validation = await validateBitbucketWorkspaceAccessToken({
    accessToken: input.accessToken,
  });

  const integrationId = randomUUID();
  const credentialId = randomUUID();
  const credentialVersion = INITIAL_CREDENTIAL_VERSION;
  const validatedAt = new Date().toISOString();
  const tokenEncrypted = encryptAccessToken({
    accessToken: input.accessToken,
    credentialId,
    integrationId,
    organizationId,
    credentialVersion,
  });
  const metadata = BitbucketWorkspaceAccessTokenMetadataSchema.parse({
    displayName: validation.workspace.displayName,
  });
  const repositories = cacheRepositories(validation.repositories);

  return db.transaction(async tx => {
    await acquireOrganizationCredentialLock(tx, organizationId);
    const actor = await requireOrganizationManager(tx, organizationId, input.actorUserId);

    const [currentBitbucketIntegration] = await tx
      .select({ id: platform_integrations.id })
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.owned_by_organization_id, organizationId),
          eq(platform_integrations.platform, BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM)
        )
      )
      .for('update');
    if (currentBitbucketIntegration) {
      throw new BitbucketWorkspaceAccessTokenCredentialError('credential_conflict');
    }

    await tx.insert(platform_integrations).values({
      id: integrationId,
      owned_by_organization_id: organizationId,
      owned_by_user_id: null,
      created_by_user_id: input.actorUserId,
      platform: BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM,
      integration_type: BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE,
      platform_installation_id: null,
      platform_account_id: validation.workspace.uuid,
      platform_account_login: validation.workspace.slug,
      permissions: null,
      scopes: null,
      repository_access: 'all',
      repositories,
      repositories_synced_at: validatedAt,
      auth_invalid_at: null,
      auth_invalid_reason: null,
      integration_status: INTEGRATION_STATUS.ACTIVE,
      metadata,
      updated_at: validatedAt,
    });
    await tx.insert(platform_access_token_credentials).values({
      id: credentialId,
      platform_integration_id: integrationId,
      owned_by_organization_id: organizationId,
      platform: BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM,
      integration_type: BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE,
      token_encrypted: tokenEncrypted,
      expires_at: null,
      provider_credential_type: validation.providerCredentialType,
      provider_scopes: validation.providerScopes,
      provider_verified_at: validatedAt,
      credential_version: credentialVersion,
      last_validated_at: validatedAt,
      updated_at: validatedAt,
    });
    await writeAudit({
      tx,
      actor,
      organizationId,
      action: 'connected',
      integrationId,
      workspaceUuid: validation.workspace.uuid,
      workspaceSlug: validation.workspace.slug,
    });

    return {
      integrationId,
      workspace: validation.workspace,
      credentialVersion,
      repositoryCount: repositories.length,
      validatedAt,
      unexpectedScopes: getUnexpectedBitbucketWorkspaceAccessTokenScopes(validation.providerScopes),
    };
  });
}
