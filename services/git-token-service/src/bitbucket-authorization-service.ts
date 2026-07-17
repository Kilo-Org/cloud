import { createPrivateKey, createPublicKey } from 'node:crypto';
import {
  decryptKeyedEnvelope,
  encryptKeyedEnvelope,
  EncryptionConfigurationError,
} from '@kilocode/encryption';
import { getWorkerDb } from '@kilocode/db/client';
import {
  kilocode_users,
  organization_memberships,
  platform_integrations,
  platform_oauth_credentials,
} from '@kilocode/db/schema';
import {
  BitbucketOAuthCredentialRowSchema,
  type BitbucketOAuthCredentialRow,
} from '@kilocode/worker-utils/bitbucket-workspace-access-token';
import { and, eq, exists, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';

const BITBUCKET_PLATFORM = 'bitbucket';
const TOKEN_SCHEME = 'bitbucket-oauth-credential-rsa-aes-256-gcm';
export const BITBUCKET_API_MINIMUM_VALIDITY_MS = 5 * 60 * 1000;
export const BITBUCKET_CLOUD_AGENT_MINIMUM_VALIDITY_MS = 55 * 60 * 1000;

const WorkspaceSchema = z
  .object({
    uuid: z.string().min(1),
    slug: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();
const MetadataSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('workspace_selection_required'),
      availableWorkspaces: z.array(WorkspaceSchema).min(1),
    })
    .strict(),
  z.object({ state: z.literal('active'), workspace: WorkspaceSchema }).strict(),
]);
const RefreshResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z
    .string()
    .transform(value => value.toLowerCase())
    .pipe(z.literal('bearer')),
  expires_in: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60),
  scope: z.string(),
});
const RefreshErrorSchema = z.object({ error: z.string() });

export type BitbucketAuthorizationOwner = {
  userId: string;
  orgId?: string;
};
export type BitbucketWorkspaceIdentity = z.infer<typeof WorkspaceSchema>;
export type BitbucketAuthorizationResult =
  | {
      status: 'available';
      token: string;
      integrationId: string;
      workspace: BitbucketWorkspaceIdentity;
    }
  | { status: 'not_connected' }
  | { status: 'workspace_selection_required' }
  | { status: 'reconnect_required' }
  | { status: 'temporarily_unavailable' };

type WorkerDb = ReturnType<typeof getWorkerDb>;
type WorkerTransaction = Parameters<Parameters<WorkerDb['transaction']>[0]>[0];
type Secret = SecretsStoreSecret | string | undefined;
type BitbucketAuthorizationEnv = Pick<CloudflareEnv, 'HYPERDRIVE'> & {
  BITBUCKET_CLIENT_ID?: Secret;
  BITBUCKET_CLIENT_SECRET?: Secret;
  BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID?: Secret;
  BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY?: Secret;
  BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PRIVATE_KEY?: Secret;
};

type ActiveAuthorization = {
  credential: BitbucketOAuthCredentialRow;
  integrationId: string;
  owner: BitbucketAuthorizationOwner;
  scopes: string[] | null;
  workspace: BitbucketWorkspaceIdentity;
};

const BITBUCKET_OAUTH_SCOPE_ALIASES: Record<string, readonly string[]> = {
  'read:account:bitbucket-legacy': ['account'],
  'read:email:bitbucket-legacy': ['email'],
  'read:repository:bitbucket-legacy': ['repository'],
  'write:repository:bitbucket-legacy': ['repository:write'],
  'read:webhook:bitbucket-legacy': ['webhook'],
  'write:webhook:bitbucket-legacy': ['webhook'],
  'admin:webhook:bitbucket-legacy': ['webhook'],
  pullrequest: ['pullrequest'],
  'read:pullrequest:bitbucket-legacy': ['pullrequest'],
  offline_access: [],
};

async function resolveSecret(secret: Secret): Promise<string | null> {
  if (!secret) return null;
  const value = typeof secret === 'string' ? secret : await secret.get();
  return value || null;
}

function normalizedScopes(scope: string): string[] | null {
  const scopes = new Set<string>();
  for (const rawScope of scope.split(/\s+/).filter(Boolean)) {
    for (const normalizedScope of BITBUCKET_OAUTH_SCOPE_ALIASES[rawScope.toLowerCase()] ?? [
      rawScope.toLowerCase(),
    ]) {
      scopes.add(normalizedScope);
    }
  }

  if (scopes.has('repository:write')) scopes.add('repository');
  if (scopes.has('account')) scopes.add('email');
  const allowed = new Set([
    'account',
    'email',
    'repository',
    'repository:write',
    'pullrequest',
    'webhook',
  ]);
  if (
    !scopes.has('account') ||
    !scopes.has('repository:write') ||
    !scopes.has('pullrequest') ||
    !scopes.has('webhook')
  ) {
    return null;
  }
  return [...scopes].filter(scope => allowed.has(scope)).sort();
}

function hasRequiredStoredScopes(scopes: string[] | null): boolean {
  if (!scopes) return false;
  return normalizedScopes(scopes.join(' ')) !== null;
}

function typedOwner(owner: BitbucketAuthorizationOwner) {
  return owner.orgId ? { type: 'org', id: owner.orgId } : { type: 'user', id: owner.userId };
}

function ownerCondition(owner: BitbucketAuthorizationOwner) {
  return owner.orgId
    ? eq(platform_integrations.owned_by_organization_id, owner.orgId)
    : and(
        eq(platform_integrations.owned_by_user_id, owner.userId),
        isNull(platform_integrations.owned_by_organization_id)
      );
}

export function buildBitbucketAuthorizationQuery(
  db: WorkerDb | WorkerTransaction,
  owner: BitbucketAuthorizationOwner
) {
  const currentOrganizationMembership = owner.orgId
    ? exists(
        db
          .select({ id: organization_memberships.id })
          .from(organization_memberships)
          .where(
            and(
              eq(organization_memberships.organization_id, owner.orgId),
              eq(organization_memberships.kilo_user_id, owner.userId)
            )
          )
      )
    : undefined;
  const currentOrganizationAccess = owner.orgId
    ? or(currentOrganizationMembership, eq(kilocode_users.is_admin, true))
    : undefined;

  return db
    .select({
      credential: platform_oauth_credentials,
      integrationId: platform_integrations.id,
      integrationStatus: platform_integrations.integration_status,
      installationId: platform_integrations.platform_installation_id,
      accountId: platform_integrations.platform_account_id,
      accountLogin: platform_integrations.platform_account_login,
      scopes: platform_integrations.scopes,
      metadata: platform_integrations.metadata,
    })
    .from(platform_integrations)
    .leftJoin(
      platform_oauth_credentials,
      eq(platform_oauth_credentials.platform_integration_id, platform_integrations.id)
    )
    .innerJoin(
      kilocode_users,
      and(eq(kilocode_users.id, owner.userId), isNull(kilocode_users.blocked_reason))
    )
    .where(
      and(
        ownerCondition(owner),
        eq(platform_integrations.platform, BITBUCKET_PLATFORM),
        currentOrganizationAccess
      )
    )
    .limit(1);
}

function credentialAad(
  credential: BitbucketOAuthCredentialRow,
  owner: BitbucketAuthorizationOwner,
  kind: 'access' | 'refresh'
): string {
  return JSON.stringify({
    scheme: TOKEN_SCHEME,
    version: 1,
    platform: BITBUCKET_PLATFORM,
    credentialId: credential.id,
    integrationId: credential.platform_integration_id,
    owner: typedOwner(owner),
    authorizedByUserId: credential.authorized_by_user_id,
    kind,
  });
}

export class BitbucketAuthorizationService {
  constructor(private env: BitbucketAuthorizationEnv) {}

  async getAuthorization(
    owner: BitbucketAuthorizationOwner,
    minimumValidityMs = BITBUCKET_API_MINIMUM_VALIDITY_MS
  ): Promise<BitbucketAuthorizationResult> {
    if (!this.env.HYPERDRIVE) return { status: 'temporarily_unavailable' };
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString, { statement_timeout: 10_000 });
    const loaded = await this.loadAuthorization(db, owner);
    if (loaded.status !== 'available') return loaded;

    let authorization = loaded.authorization;
    const accessTokenExpiresAt = authorization.credential.access_token_expires_at;
    if (!accessTokenExpiresAt) return { status: 'reconnect_required' };
    if (new Date(accessTokenExpiresAt).getTime() - Date.now() < minimumValidityMs) {
      const refreshed = await this.refreshWithLock(db, authorization, minimumValidityMs);
      if (refreshed.status !== 'available') return refreshed;
      authorization = refreshed.authorization;
    }

    const token = await this.decryptCredential(authorization, 'access');
    if (!token) return { status: 'reconnect_required' };
    await db
      .update(platform_oauth_credentials)
      .set({ last_used_at: new Date().toISOString() })
      .where(eq(platform_oauth_credentials.id, authorization.credential.id));
    return {
      status: 'available',
      token,
      integrationId: authorization.integrationId,
      workspace: authorization.workspace,
    };
  }

  private async loadAuthorization(
    db: WorkerDb | WorkerTransaction,
    owner: BitbucketAuthorizationOwner
  ): Promise<
    | { status: 'available'; authorization: ActiveAuthorization }
    | Exclude<BitbucketAuthorizationResult, { status: 'available' }>
  > {
    const [row] = await buildBitbucketAuthorizationQuery(db, owner);
    if (!row) return { status: 'not_connected' };
    const credential = BitbucketOAuthCredentialRowSchema.safeParse(row.credential);
    if (!credential.success || credential.data.revoked_at) {
      return { status: 'reconnect_required' };
    }

    const metadata = MetadataSchema.safeParse(row.metadata);
    if (!metadata.success) return { status: 'reconnect_required' };
    if (
      row.integrationStatus === 'pending' &&
      metadata.data.state === 'workspace_selection_required'
    ) {
      return { status: 'workspace_selection_required' };
    }
    if (
      row.integrationStatus !== 'active' ||
      metadata.data.state !== 'active' ||
      row.installationId !== metadata.data.workspace.uuid ||
      row.accountId !== metadata.data.workspace.uuid ||
      row.accountLogin !== metadata.data.workspace.slug ||
      !hasRequiredStoredScopes(row.scopes)
    ) {
      return { status: 'reconnect_required' };
    }
    return {
      status: 'available',
      authorization: {
        credential: credential.data,
        integrationId: row.integrationId,
        owner,
        scopes: row.scopes,
        workspace: metadata.data.workspace,
      },
    };
  }

  private async refreshWithLock(
    db: WorkerDb,
    candidate: ActiveAuthorization,
    minimumValidityMs: number
  ): Promise<
    | { status: 'available'; authorization: ActiveAuthorization }
    | Exclude<BitbucketAuthorizationResult, { status: 'available' }>
  > {
    return db.transaction(async tx => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bitbucket-oauth-credential:${candidate.credential.id}`}, 0))`
      );
      const current = await this.loadAuthorization(tx, candidate.owner);
      if (current.status !== 'available') return current;
      const currentExpiry = current.authorization.credential.access_token_expires_at;
      if (!currentExpiry) return { status: 'reconnect_required' };
      if (
        current.authorization.credential.credential_version !==
          candidate.credential.credential_version ||
        new Date(currentExpiry).getTime() - Date.now() >= minimumValidityMs
      ) {
        return current;
      }
      return this.refreshAuthorization(tx, current.authorization);
    });
  }

  private async refreshAuthorization(
    tx: WorkerTransaction,
    authorization: ActiveAuthorization
  ): Promise<
    | { status: 'available'; authorization: ActiveAuthorization }
    | Exclude<BitbucketAuthorizationResult, { status: 'available' }>
  > {
    const [clientId, clientSecret, refreshToken] = await Promise.all([
      resolveSecret(this.env.BITBUCKET_CLIENT_ID),
      resolveSecret(this.env.BITBUCKET_CLIENT_SECRET),
      this.decryptCredential(authorization, 'refresh'),
    ]);
    if (!clientId || !clientSecret) return { status: 'temporarily_unavailable' };
    if (!refreshToken) return { status: 'reconnect_required' };

    let response: Response;
    try {
      response = await fetch('https://bitbucket.org/site/oauth2/access_token', {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }).toString(),
      });
    } catch {
      return { status: 'temporarily_unavailable' };
    }

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      return { status: 'temporarily_unavailable' };
    }
    if (!response.ok) {
      const error = RefreshErrorSchema.safeParse(responseBody);
      if (error.success && error.data.error === 'invalid_grant') {
        await tx
          .update(platform_oauth_credentials)
          .set({
            revoked_at: new Date().toISOString(),
            revocation_reason: 'refresh_token_rejected',
          })
          .where(
            and(
              eq(platform_oauth_credentials.id, authorization.credential.id),
              eq(
                platform_oauth_credentials.credential_version,
                authorization.credential.credential_version
              ),
              isNull(platform_oauth_credentials.revoked_at)
            )
          );
        return { status: 'reconnect_required' };
      }
      return { status: 'temporarily_unavailable' };
    }

    const parsed = RefreshResponseSchema.safeParse(responseBody);
    if (!parsed.success) return { status: 'temporarily_unavailable' };
    const scopes = normalizedScopes(parsed.data.scope);
    if (!scopes) return { status: 'temporarily_unavailable' };
    const [accessTokenEncrypted, refreshTokenEncrypted] = await Promise.all([
      this.encryptCredential(parsed.data.access_token, authorization, 'access'),
      this.encryptCredential(parsed.data.refresh_token, authorization, 'refresh'),
    ]);
    if (!accessTokenEncrypted || !refreshTokenEncrypted) {
      return { status: 'temporarily_unavailable' };
    }

    const [updated] = await tx
      .update(platform_oauth_credentials)
      .set({
        access_token_encrypted: accessTokenEncrypted,
        access_token_expires_at: new Date(Date.now() + parsed.data.expires_in * 1000).toISOString(),
        refresh_token_encrypted: refreshTokenEncrypted,
        credential_version: sql`${platform_oauth_credentials.credential_version} + 1`,
        last_used_at: new Date().toISOString(),
      })
      .where(
        and(
          eq(platform_oauth_credentials.id, authorization.credential.id),
          eq(
            platform_oauth_credentials.credential_version,
            authorization.credential.credential_version
          ),
          isNull(platform_oauth_credentials.revoked_at)
        )
      )
      .returning();
    if (!updated) return this.loadAuthorization(tx, authorization.owner);
    const credential = BitbucketOAuthCredentialRowSchema.safeParse(updated);
    if (!credential.success) return { status: 'reconnect_required' };

    await tx
      .update(platform_integrations)
      .set({ scopes, updated_at: new Date().toISOString() })
      .where(eq(platform_integrations.id, authorization.integrationId));
    return {
      status: 'available',
      authorization: { ...authorization, credential: credential.data, scopes },
    };
  }

  private async decryptCredential(
    authorization: ActiveAuthorization,
    kind: 'access' | 'refresh'
  ): Promise<string | null> {
    try {
      const keyId = await resolveSecret(this.env.BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID);
      const encodedPrivateKey = await resolveSecret(
        this.env.BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PRIVATE_KEY
      );
      if (!keyId || !encodedPrivateKey) return null;
      const privateKeyPem = Buffer.from(encodedPrivateKey, 'base64').toString('utf8');
      const privateKey = createPrivateKey(privateKeyPem);
      if (privateKey.asymmetricKeyType !== 'rsa') return null;
      return decryptKeyedEnvelope(
        kind === 'access'
          ? authorization.credential.access_token_encrypted
          : authorization.credential.refresh_token_encrypted,
        TOKEN_SCHEME,
        { active: { keyId, privateKeyPem } },
        credentialAad(authorization.credential, authorization.owner, kind)
      );
    } catch {
      return null;
    }
  }

  private async encryptCredential(
    value: string,
    authorization: ActiveAuthorization,
    kind: 'access' | 'refresh'
  ): Promise<string | null> {
    try {
      const keyId = await resolveSecret(this.env.BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID);
      const encodedPublicKey = await resolveSecret(
        this.env.BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY
      );
      if (!keyId || !encodedPublicKey) return null;
      const publicKeyPem = Buffer.from(encodedPublicKey, 'base64').toString('utf8');
      const publicKey = createPublicKey(publicKeyPem);
      if (publicKey.asymmetricKeyType !== 'rsa') return null;
      return encryptKeyedEnvelope(
        value,
        TOKEN_SCHEME,
        { keyId, publicKeyPem },
        credentialAad(authorization.credential, authorization.owner, kind)
      );
    } catch (error) {
      if (error instanceof EncryptionConfigurationError) return null;
      return null;
    }
  }
}
