import 'server-only';

import { createPublicKey, randomUUID } from 'node:crypto';
import {
  BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID,
  BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY,
} from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import type { Owner } from '@/lib/integrations/core/types';
import { encryptKeyedEnvelope } from '@kilocode/encryption';
import {
  kilocode_users,
  organization_memberships,
  platform_integrations,
  platform_oauth_credentials,
  type NewPlatformOAuthCredential,
} from '@kilocode/db/schema';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { BitbucketOAuthTokens, BitbucketUser } from './adapter';
import { BitbucketIntegrationMetadataSchema, type BitbucketWorkspace } from './metadata';

export const BITBUCKET_OAUTH_CREDENTIAL_ENVELOPE_SCHEME =
  'bitbucket-oauth-credential-rsa-aes-256-gcm';

export class BitbucketIntegrationAuthorizationError extends Error {}
export class BitbucketIntegrationConnectionConflictError extends Error {
  constructor() {
    super('Bitbucket is already connected for this owner');
    this.name = 'BitbucketIntegrationConnectionConflictError';
  }
}

export function buildBitbucketOAuthCredentialAad(input: {
  credentialId: string;
  integrationId: string;
  owner: Owner;
  authorizedByUserId: string;
  kind: 'access' | 'refresh';
}): string {
  return JSON.stringify({
    scheme: BITBUCKET_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
    version: 1,
    platform: PLATFORM.BITBUCKET,
    credentialId: input.credentialId,
    integrationId: input.integrationId,
    owner: input.owner,
    authorizedByUserId: input.authorizedByUserId,
    kind: input.kind,
  });
}

export type StoreBitbucketIntegrationInput = {
  owner: Owner;
  authorizedByUserId: string;
  bitbucketUser: Pick<BitbucketUser, 'uuid' | 'nickname'>;
  tokens: BitbucketOAuthTokens;
  availableWorkspaces: BitbucketWorkspace[];
};

function normalizeBitbucketUuid(value: string): string {
  const unbraced = value.startsWith('{') && value.endsWith('}') ? value.slice(1, -1) : value;
  return unbraced.toLowerCase();
}

function requireCredentialEncryptionKey(): { keyId: string; publicKeyPem: Buffer } {
  const keyId = BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID;
  const encodedPublicKey = BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY;
  if (!keyId || keyId.trim() !== keyId || !encodedPublicKey) {
    throw new Error('Bitbucket OAuth credential encryption is not configured');
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
    throw new Error('Bitbucket OAuth credential encryption is not configured');
  }
  return { keyId, publicKeyPem };
}

function ownerCondition(owner: Owner) {
  return owner.type === 'user'
    ? eq(platform_integrations.owned_by_user_id, owner.id)
    : eq(platform_integrations.owned_by_organization_id, owner.id);
}

export async function storeBitbucketIntegration(input: StoreBitbucketIntegrationInput): Promise<{
  status: 'connected' | 'workspace_selection_required';
  integrationId: string;
}> {
  const integrationId = randomUUID();
  const credentialId = randomUUID();
  const providerSubjectId = normalizeBitbucketUuid(input.bitbucketUser.uuid);
  const availableWorkspaces = input.availableWorkspaces.map(workspace => ({
    uuid: normalizeBitbucketUuid(workspace.uuid),
    slug: workspace.slug,
    name: workspace.name,
  }));
  const selectedWorkspace = availableWorkspaces.length === 1 ? availableWorkspaces[0] : undefined;
  const metadata = BitbucketIntegrationMetadataSchema.parse(
    selectedWorkspace
      ? { state: 'active', workspace: selectedWorkspace }
      : { state: 'workspace_selection_required', availableWorkspaces }
  );
  const status = selectedWorkspace ? 'connected' : 'workspace_selection_required';
  const encryptionKey = requireCredentialEncryptionKey();
  const accessTokenExpiresAt = new Date(Date.now() + input.tokens.expiresIn * 1000).toISOString();
  const accessTokenEncrypted = encryptKeyedEnvelope(
    input.tokens.accessToken,
    BITBUCKET_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
    encryptionKey,
    buildBitbucketOAuthCredentialAad({
      credentialId,
      integrationId,
      owner: input.owner,
      authorizedByUserId: input.authorizedByUserId,
      kind: 'access',
    })
  );
  const refreshTokenEncrypted = encryptKeyedEnvelope(
    input.tokens.refreshToken,
    BITBUCKET_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
    encryptionKey,
    buildBitbucketOAuthCredentialAad({
      credentialId,
      integrationId,
      owner: input.owner,
      authorizedByUserId: input.authorizedByUserId,
      kind: 'refresh',
    })
  );
  const credentialValues: NewPlatformOAuthCredential = {
    id: credentialId,
    platform_integration_id: integrationId,
    platform: PLATFORM.BITBUCKET,
    authorized_by_user_id: input.authorizedByUserId,
    provider_subject_id: providerSubjectId,
    provider_subject_login: input.bitbucketUser.nickname,
    access_token_encrypted: accessTokenEncrypted,
    access_token_expires_at: accessTokenExpiresAt,
    refresh_token_encrypted: refreshTokenEncrypted,
  };

  return db.transaction(async tx => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bitbucket-oauth-owner:${input.owner.type}:${input.owner.id}`}, 0))`
    );

    if (input.owner.type === 'org') {
      const [authorizer] = await tx
        .select({ isAdmin: kilocode_users.is_admin })
        .from(kilocode_users)
        .where(
          and(
            eq(kilocode_users.id, input.authorizedByUserId),
            isNull(kilocode_users.blocked_reason)
          )
        )
        .for('update');
      if (!authorizer) {
        throw new BitbucketIntegrationAuthorizationError(
          'Bitbucket integration authorizer is no longer authorized'
        );
      }

      if (!authorizer.isAdmin) {
        const [membership] = await tx
          .select({ id: organization_memberships.id })
          .from(organization_memberships)
          .where(
            and(
              eq(organization_memberships.organization_id, input.owner.id),
              eq(organization_memberships.kilo_user_id, input.authorizedByUserId),
              inArray(organization_memberships.role, ['owner', 'billing_manager'])
            )
          )
          .for('update');
        if (!membership) {
          throw new BitbucketIntegrationAuthorizationError(
            'Bitbucket integration authorizer is no longer authorized'
          );
        }
      }
    }

    const [currentIntegration] = await tx
      .select({ id: platform_integrations.id })
      .from(platform_integrations)
      .where(
        and(ownerCondition(input.owner), eq(platform_integrations.platform, PLATFORM.BITBUCKET))
      )
      .for('update');
    if (currentIntegration) {
      throw new BitbucketIntegrationConnectionConflictError();
    }

    await tx.insert(platform_integrations).values({
      id: integrationId,
      owned_by_user_id: input.owner.type === 'user' ? input.owner.id : null,
      owned_by_organization_id: input.owner.type === 'org' ? input.owner.id : null,
      created_by_user_id: input.authorizedByUserId,
      platform: PLATFORM.BITBUCKET,
      integration_type: 'oauth',
      platform_installation_id: selectedWorkspace?.uuid ?? null,
      platform_account_id: selectedWorkspace?.uuid ?? null,
      platform_account_login: selectedWorkspace?.slug ?? null,
      permissions: null,
      scopes: [...input.tokens.scopes],
      repository_access: 'all',
      repositories: null,
      integration_status: selectedWorkspace
        ? INTEGRATION_STATUS.ACTIVE
        : INTEGRATION_STATUS.PENDING,
      metadata,
    });
    await tx.insert(platform_oauth_credentials).values(credentialValues);

    return { status, integrationId };
  });
}
