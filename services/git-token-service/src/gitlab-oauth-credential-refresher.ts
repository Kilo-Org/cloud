import { getWorkerDb } from '@kilocode/db/client';
import { platform_integrations, platform_oauth_credentials } from '@kilocode/db/schema';
import {
  GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
  GitLabOAuthCredentialRowSchema,
  buildGitLabOAuthCredentialAad,
  type GitLabCredentialOwner,
} from '@kilocode/worker-utils/gitlab-credential';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  GitLabCredentialCrypto,
  type GitLabCredentialCryptoEnv,
} from './gitlab-credential-crypto.js';
import type { GitLabOAuthCredentialRefresher as GitLabOAuthCredentialRefresherContract } from './gitlab-credential-service.js';
import { normalizeGitLabInstanceUrl } from './gitlab-url.js';

type Secret = SecretsStoreSecret | string | undefined;
type GitLabOAuthCredentialRefresherEnv = GitLabCredentialCryptoEnv & {
  HYPERDRIVE?: Hyperdrive;
  GITLAB_CLIENT_ID?: Secret;
  GITLAB_CLIENT_SECRET?: Secret;
};

type RefreshInput = Parameters<GitLabOAuthCredentialRefresherContract['refresh']>[0];
type RefreshResult = Awaited<ReturnType<GitLabOAuthCredentialRefresherContract['refresh']>>;

export type GitLabLegacyOAuthPromotionResult =
  | { status: 'available'; token: string; instanceUrl: string }
  | { status: 'encrypted_credential_available' }
  | { status: 'reconnect_required' }
  | { status: 'temporarily_unavailable' };

const OAuthRefreshResponseSchema = z
  .object({
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
    created_at: z.number().int().positive(),
    scope: z.string(),
  })
  .strict();

const OAuthRefreshErrorSchema = z.object({ error: z.string() });
const GitLabRefreshMetadataSchema = z
  .object({
    access_token: z.string().optional(),
    refresh_token: z.string().optional(),
    token_expires_at: z.string().optional(),
    gitlab_instance_url: z.string().optional(),
    client_id: z.string().min(1).optional(),
    client_secret: z.string().optional(),
    auth_type: z.enum(['oauth', 'pat']).optional(),
  })
  .passthrough();

const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const MAX_REFRESH_RESPONSE_BYTES = 64_000;
type OAuthProviderRefreshResult =
  | { status: 'available'; data: z.infer<typeof OAuthRefreshResponseSchema> }
  | { status: 'invalid_grant' }
  | { status: 'temporarily_unavailable' };

async function resolveSecret(secret: Secret): Promise<string | null> {
  if (!secret) return null;
  const value = typeof secret === 'string' ? secret : await secret.get();
  return value || null;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('invalid_response');
  const contentLength = response.headers.get('Content-Length');
  if (
    contentLength &&
    (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > MAX_REFRESH_RESPONSE_BYTES)
  ) {
    throw new Error('invalid_response');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw new Error('invalid_response');
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_REFRESH_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('invalid_response');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
}

function ownsParent(
  row: {
    ownedByUserId: string | null;
    ownedByOrganizationId: string | null;
  },
  input: RefreshInput
): boolean {
  return input.owner.type === 'org'
    ? row.ownedByOrganizationId === input.owner.id && row.ownedByUserId === null
    : row.ownedByUserId === input.owner.id && row.ownedByOrganizationId === null;
}

export class GitLabOAuthCredentialRefresher implements GitLabOAuthCredentialRefresherContract {
  private crypto: GitLabCredentialCrypto;

  constructor(
    private env: GitLabOAuthCredentialRefresherEnv,
    private dependencies: {
      crypto?: GitLabCredentialCrypto;
      fetch?: typeof fetch;
      now?: () => Date;
    } = {}
  ) {
    this.crypto = dependencies.crypto ?? new GitLabCredentialCrypto(env);
  }

  async promoteLegacy(input: {
    actor: { userId: string; orgId?: string };
    integrationId: string;
  }): Promise<GitLabLegacyOAuthPromotionResult> {
    if (!this.env.HYPERDRIVE) return { status: 'temporarily_unavailable' };
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString, { statement_timeout: 10_000 });
    try {
      return await db.transaction(async tx => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`gitlab-integration:${input.integrationId}`}, 0))`
        );
        const [loaded] = await tx
          .select({
            credential: platform_oauth_credentials,
            integrationId: platform_integrations.id,
            platform: platform_integrations.platform,
            integrationType: platform_integrations.integration_type,
            integrationStatus: platform_integrations.integration_status,
            ownedByUserId: platform_integrations.owned_by_user_id,
            ownedByOrganizationId: platform_integrations.owned_by_organization_id,
            accountId: platform_integrations.platform_account_id,
            accountLogin: platform_integrations.platform_account_login,
            metadata: platform_integrations.metadata,
          })
          .from(platform_integrations)
          .leftJoin(
            platform_oauth_credentials,
            eq(platform_oauth_credentials.platform_integration_id, platform_integrations.id)
          )
          .where(eq(platform_integrations.id, input.integrationId))
          .limit(1);
        if (!loaded) return { status: 'reconnect_required' } as const;
        if (loaded.credential !== null) {
          return { status: 'encrypted_credential_available' } as const;
        }

        const metadata = GitLabRefreshMetadataSchema.safeParse(loaded.metadata ?? {});
        const owner: GitLabCredentialOwner | null = input.actor.orgId
          ? loaded.ownedByOrganizationId === input.actor.orgId && loaded.ownedByUserId === null
            ? { type: 'org', id: input.actor.orgId }
            : null
          : loaded.ownedByUserId === input.actor.userId && loaded.ownedByOrganizationId === null
            ? { type: 'user', id: input.actor.userId }
            : null;
        const instanceUrl = metadata.success
          ? normalizeGitLabInstanceUrl(metadata.data.gitlab_instance_url ?? 'https://gitlab.com')
          : null;
        if (
          !metadata.success ||
          !owner ||
          !instanceUrl ||
          loaded.platform !== 'gitlab' ||
          loaded.integrationType !== 'oauth' ||
          loaded.integrationStatus !== 'active' ||
          !loaded.accountId ||
          !loaded.accountLogin ||
          metadata.data.auth_type !== 'oauth' ||
          !metadata.data.access_token
        ) {
          return { status: 'reconnect_required' } as const;
        }

        const now = (this.dependencies.now ?? (() => new Date()))();
        if (
          metadata.data.token_expires_at &&
          new Date(metadata.data.token_expires_at).getTime() - now.getTime() > REFRESH_BUFFER_MS
        ) {
          return {
            status: 'available',
            token: metadata.data.access_token,
            instanceUrl,
          } as const;
        }
        if (!metadata.data.refresh_token) return { status: 'reconnect_required' } as const;

        const clientId =
          metadata.data.client_id ?? (await resolveSecret(this.env.GITLAB_CLIENT_ID));
        const clientSecret = metadata.data.client_id
          ? (metadata.data.client_secret ?? null)
          : await resolveSecret(this.env.GITLAB_CLIENT_SECRET);
        if (!clientId || !clientSecret) return { status: 'temporarily_unavailable' } as const;

        const refreshed = await this.requestOAuthRefresh({
          instanceUrl,
          clientId,
          clientSecret,
          refreshToken: metadata.data.refresh_token,
        });
        if (refreshed.status === 'invalid_grant') {
          return { status: 'reconnect_required' } as const;
        }
        if (refreshed.status !== 'available') {
          return { status: 'temporarily_unavailable' } as const;
        }

        const credentialId = crypto.randomUUID();
        const credentialVersion = 1;
        const authorizedByUserId = owner.type === 'user' ? owner.id : null;
        const encrypt = (plaintext: string, kind: 'access' | 'refresh' | 'oauth-client-secret') =>
          this.crypto.encrypt({
            plaintext,
            scheme: GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
            aad: buildGitLabOAuthCredentialAad({
              credentialId,
              integrationId: loaded.integrationId,
              providerBaseUrl: instanceUrl,
              owner,
              authorizedByUserId,
              credentialVersion,
              kind,
            }),
          });
        const [accessTokenEncrypted, refreshTokenEncrypted, clientSecretEncrypted] =
          await Promise.all([
            encrypt(refreshed.data.access_token, 'access'),
            encrypt(refreshed.data.refresh_token, 'refresh'),
            metadata.data.client_id
              ? encrypt(clientSecret, 'oauth-client-secret')
              : Promise.resolve(null),
          ]);
        if (
          accessTokenEncrypted.status !== 'available' ||
          refreshTokenEncrypted.status !== 'available' ||
          (clientSecretEncrypted && clientSecretEncrypted.status !== 'available')
        ) {
          return { status: 'temporarily_unavailable' } as const;
        }
        const expiresAt = new Date(
          (refreshed.data.created_at + refreshed.data.expires_in) * 1000
        ).toISOString();
        const inserted = await tx
          .insert(platform_oauth_credentials)
          .values({
            id: credentialId,
            platform_integration_id: loaded.integrationId,
            authorized_by_user_id: authorizedByUserId,
            provider_subject_id: loaded.accountId,
            provider_subject_login: loaded.accountLogin,
            provider_base_url: instanceUrl,
            access_token_encrypted: accessTokenEncrypted.ciphertext,
            access_token_expires_at: expiresAt,
            refresh_token_encrypted: refreshTokenEncrypted.ciphertext,
            refresh_token_expires_at: null,
            oauth_client_secret_encrypted: clientSecretEncrypted?.ciphertext ?? null,
            credential_version: credentialVersion,
            last_used_at: now.toISOString(),
          })
          .onConflictDoNothing()
          .returning({ id: platform_oauth_credentials.id });
        if (inserted.length === 0) {
          return { status: 'encrypted_credential_available' } as const;
        }

        await tx
          .update(platform_integrations)
          .set({
            integration_type: 'oauth',
            scopes: refreshed.data.scope.split(/\s+/).filter(Boolean),
            updated_at: now.toISOString(),
          })
          .where(eq(platform_integrations.id, loaded.integrationId));
        return {
          status: 'available',
          token: refreshed.data.access_token,
          instanceUrl,
        } as const;
      });
    } catch {
      return { status: 'temporarily_unavailable' };
    }
  }

  async refresh(input: RefreshInput): Promise<RefreshResult> {
    if (!this.env.HYPERDRIVE) return { status: 'temporarily_unavailable' };
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString, { statement_timeout: 10_000 });
    try {
      return await db.transaction(async tx => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`gitlab-integration:${input.parent.integrationId}`}, 0))`
        );
        const [loaded] = await tx
          .select({
            credential: platform_oauth_credentials,
            integrationId: platform_integrations.id,
            platform: platform_integrations.platform,
            integrationType: platform_integrations.integration_type,
            integrationStatus: platform_integrations.integration_status,
            ownedByUserId: platform_integrations.owned_by_user_id,
            ownedByOrganizationId: platform_integrations.owned_by_organization_id,
            accountId: platform_integrations.platform_account_id,
            accountLogin: platform_integrations.platform_account_login,
            metadata: platform_integrations.metadata,
          })
          .from(platform_integrations)
          .innerJoin(
            platform_oauth_credentials,
            eq(platform_oauth_credentials.platform_integration_id, platform_integrations.id)
          )
          .where(eq(platform_integrations.id, input.parent.integrationId))
          .limit(1);
        if (!loaded) return { status: 'reconnect_required' };

        const parsedCredential = GitLabOAuthCredentialRowSchema.safeParse(loaded.credential);
        const parsedMetadata = GitLabRefreshMetadataSchema.safeParse(loaded.metadata ?? {});
        if (!parsedCredential.success || !parsedMetadata.success) {
          return { status: 'reconnect_required' };
        }
        const credential = parsedCredential.data;
        const metadata = parsedMetadata.data;
        const instanceUrl = normalizeGitLabInstanceUrl(
          metadata.gitlab_instance_url ?? 'https://gitlab.com'
        );
        if (
          !instanceUrl ||
          instanceUrl !== credential.provider_base_url ||
          loaded.platform !== 'gitlab' ||
          loaded.integrationType !== 'oauth' ||
          loaded.integrationStatus !== 'active' ||
          credential.id !== input.credential.id ||
          loaded.integrationId !== credential.platform_integration_id ||
          loaded.accountId !== credential.provider_subject_id ||
          loaded.accountLogin !== credential.provider_subject_login ||
          credential.revoked_at !== null ||
          !ownsParent(loaded, input)
        ) {
          return { status: 'reconnect_required' };
        }

        const now = (this.dependencies.now ?? (() => new Date()))();
        if (
          credential.credential_version !== input.credential.credential_version ||
          (credential.access_token_expires_at &&
            new Date(credential.access_token_expires_at).getTime() - now.getTime() >
              REFRESH_BUFFER_MS)
        ) {
          const current = await this.decryptOAuthSecret(credential, input, 'access');
          return current.status === 'available'
            ? {
                status: 'available',
                token: current.token,
                credentialVersion: credential.credential_version,
              }
            : current.status === 'temporarily_unavailable'
              ? current
              : { status: 'reconnect_required' };
        }

        const refreshToken = credential.refresh_token_encrypted
          ? await this.decryptOAuthSecret(credential, input, 'refresh')
          : { status: 'unreadable' as const };
        if (refreshToken.status === 'temporarily_unavailable') return refreshToken;
        if (refreshToken.status !== 'available') return { status: 'reconnect_required' };

        const clientId = metadata.client_id ?? (await resolveSecret(this.env.GITLAB_CLIENT_ID));
        let clientSecret: string | null;
        if (metadata.client_id) {
          if (!credential.oauth_client_secret_encrypted) return { status: 'reconnect_required' };
          const customSecret = await this.decryptOAuthSecret(
            credential,
            input,
            'oauth-client-secret'
          );
          if (customSecret.status === 'temporarily_unavailable') return customSecret;
          if (customSecret.status !== 'available') return { status: 'reconnect_required' };
          clientSecret = customSecret.token;
        } else {
          clientSecret = await resolveSecret(this.env.GITLAB_CLIENT_SECRET);
        }
        if (!clientId || !clientSecret) return { status: 'temporarily_unavailable' };

        const refreshed = await this.requestOAuthRefresh({
          instanceUrl,
          clientId,
          clientSecret,
          refreshToken: refreshToken.token,
        });
        if (refreshed.status === 'invalid_grant') {
          await tx
            .update(platform_oauth_credentials)
            .set({
              revoked_at: now.toISOString(),
              revocation_reason: 'refresh_token_rejected',
            })
            .where(
              and(
                eq(platform_oauth_credentials.id, credential.id),
                eq(platform_oauth_credentials.credential_version, credential.credential_version),
                isNull(platform_oauth_credentials.revoked_at)
              )
            );
          return { status: 'reconnect_required' };
        }
        if (refreshed.status !== 'available') return { status: 'temporarily_unavailable' };
        const nextVersion = credential.credential_version + 1;
        const [accessTokenEncrypted, refreshTokenEncrypted] = await Promise.all([
          this.encryptOAuthSecret(
            refreshed.data.access_token,
            credential,
            input,
            'access',
            nextVersion
          ),
          this.encryptOAuthSecret(
            refreshed.data.refresh_token,
            credential,
            input,
            'refresh',
            nextVersion
          ),
        ]);
        if (
          accessTokenEncrypted.status !== 'available' ||
          refreshTokenEncrypted.status !== 'available'
        ) {
          return { status: 'temporarily_unavailable' };
        }
        const expiresAt = new Date(
          (refreshed.data.created_at + refreshed.data.expires_in) * 1000
        ).toISOString();
        const [updated] = await tx
          .update(platform_oauth_credentials)
          .set({
            access_token_encrypted: accessTokenEncrypted.ciphertext,
            access_token_expires_at: expiresAt,
            refresh_token_encrypted: refreshTokenEncrypted.ciphertext,
            credential_version: nextVersion,
            last_used_at: now.toISOString(),
          })
          .where(
            and(
              eq(platform_oauth_credentials.id, credential.id),
              eq(platform_oauth_credentials.credential_version, credential.credential_version),
              isNull(platform_oauth_credentials.revoked_at)
            )
          )
          .returning({ id: platform_oauth_credentials.id });
        if (!updated) return { status: 'temporarily_unavailable' };

        await tx
          .update(platform_integrations)
          .set({
            integration_type: 'oauth',
            scopes: refreshed.data.scope.split(/\s+/).filter(Boolean),
            updated_at: now.toISOString(),
          })
          .where(eq(platform_integrations.id, loaded.integrationId));
        return {
          status: 'available',
          token: refreshed.data.access_token,
          credentialVersion: nextVersion,
        };
      });
    } catch {
      return { status: 'temporarily_unavailable' };
    }
  }

  private async requestOAuthRefresh(input: {
    instanceUrl: string;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<OAuthProviderRefreshResult> {
    let response: Response;
    try {
      response = await (this.dependencies.fetch ?? fetch)(`${input.instanceUrl}/oauth/token`, {
        method: 'POST',
        redirect: 'manual',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: input.clientId,
          client_secret: input.clientSecret,
          refresh_token: input.refreshToken,
          grant_type: 'refresh_token',
        }),
      });
    } catch {
      return { status: 'temporarily_unavailable' };
    }

    let responseBody: unknown;
    try {
      responseBody = await readBoundedJson(response);
    } catch {
      return { status: 'temporarily_unavailable' };
    }
    if (!response.ok) {
      const refreshError = OAuthRefreshErrorSchema.safeParse(responseBody);
      return refreshError.success && refreshError.data.error === 'invalid_grant'
        ? { status: 'invalid_grant' }
        : { status: 'temporarily_unavailable' };
    }
    const refreshed = OAuthRefreshResponseSchema.safeParse(responseBody);
    return refreshed.success
      ? { status: 'available', data: refreshed.data }
      : { status: 'temporarily_unavailable' };
  }

  private decryptOAuthSecret(
    credential: z.infer<typeof GitLabOAuthCredentialRowSchema>,
    input: RefreshInput,
    kind: 'access' | 'refresh' | 'oauth-client-secret'
  ) {
    const ciphertext =
      kind === 'access'
        ? credential.access_token_encrypted
        : kind === 'refresh'
          ? credential.refresh_token_encrypted
          : credential.oauth_client_secret_encrypted;
    if (!ciphertext) return Promise.resolve({ status: 'unreadable' } as const);
    return this.crypto.decrypt({
      ciphertext,
      scheme: GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
      aad: buildGitLabOAuthCredentialAad({
        credentialId: credential.id,
        integrationId: credential.platform_integration_id,
        providerBaseUrl: credential.provider_base_url,
        owner: input.owner,
        authorizedByUserId: credential.authorized_by_user_id,
        credentialVersion: credential.credential_version,
        kind,
      }),
    });
  }

  private encryptOAuthSecret(
    plaintext: string,
    credential: z.infer<typeof GitLabOAuthCredentialRowSchema>,
    input: RefreshInput,
    kind: 'access' | 'refresh',
    credentialVersion: number
  ) {
    return this.crypto.encrypt({
      plaintext,
      scheme: GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
      aad: buildGitLabOAuthCredentialAad({
        credentialId: credential.id,
        integrationId: credential.platform_integration_id,
        providerBaseUrl: credential.provider_base_url,
        owner: input.owner,
        authorizedByUserId: credential.authorized_by_user_id,
        credentialVersion,
        kind,
      }),
    });
  }
}
