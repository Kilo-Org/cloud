import { getWorkerDb } from '@kilocode/db/client';
import { platform_integrations, platform_oauth_credentials } from '@kilocode/db/schema';
import {
  GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
  GitLabOAuthCredentialRowSchema,
  buildGitLabOAuthCredentialAad,
} from '@kilocode/worker-utils/gitlab-credential';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  GitLabCredentialCrypto,
  type GitLabCredentialCryptoEnv,
} from './gitlab-credential-crypto.js';
import type { GitLabOAuthCredentialRefresher as GitLabOAuthCredentialRefresherContract } from './gitlab-credential-service.js';
import { normalizeGitLabInstanceUrl } from './gitlab-url.js';
import { readBoundedJsonBody } from './lib/bounded-read.js';

type Secret = SecretsStoreSecret | string | undefined;
type GitLabOAuthCredentialRefresherEnv = GitLabCredentialCryptoEnv & {
  HYPERDRIVE?: Hyperdrive;
  GITLAB_CLIENT_ID?: Secret;
  GITLAB_CLIENT_SECRET?: Secret;
};

type RefreshInput = Parameters<GitLabOAuthCredentialRefresherContract['refresh']>[0];
type RefreshResult = Awaited<ReturnType<GitLabOAuthCredentialRefresherContract['refresh']>>;

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
    gitlab_instance_url: z.string().optional(),
    client_id: z.string().min(1).optional(),
  })
  .passthrough();

const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const MAX_REFRESH_RESPONSE_BYTES = 64_000;
const GITLAB_OAUTH_REFRESH_TIMEOUT_MS = 10_000;

type WorkerDb = ReturnType<typeof getWorkerDb>;
type WorkerTransaction = Parameters<Parameters<WorkerDb['transaction']>[0]>[0];

type OAuthProviderRefreshResult =
  | { status: 'available'; data: z.infer<typeof OAuthRefreshResponseSchema> }
  | { status: 'invalid_grant' }
  | { status: 'temporarily_unavailable' };

type LoadedRefreshRow = {
  credential: z.infer<typeof GitLabOAuthCredentialRowSchema>;
  metadata: z.infer<typeof GitLabRefreshMetadataSchema>;
  instanceUrl: string;
  integrationId: string;
};

type RefreshInputs = {
  credential: LoadedRefreshRow['credential'];
  metadata: LoadedRefreshRow['metadata'];
  instanceUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

type RefreshPhase = { status: 'refresh'; inputs: RefreshInputs } | RefreshResult;

async function resolveSecret(secret: Secret): Promise<string | null> {
  if (!secret) return null;
  const value = typeof secret === 'string' ? secret : await secret.get();
  return value || null;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const stream = response.body;
  if (!stream) throw new Error('invalid_response');
  const contentLength = response.headers.get('Content-Length');
  if (
    contentLength &&
    (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > MAX_REFRESH_RESPONSE_BYTES)
  ) {
    throw new Error('invalid_response');
  }
  return readBoundedJsonBody(stream, MAX_REFRESH_RESPONSE_BYTES);
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

  /**
   * Reads and validates the stored credential, calls the provider token
   * endpoint with a bounded deadline, then persists the refreshed secrets in a
   * short transaction guarded by the per-integration lock and the credential
   * version fence.
   */
  async refresh(input: RefreshInput): Promise<RefreshResult> {
    if (!this.env.HYPERDRIVE) return { status: 'temporarily_unavailable' };
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString, { statement_timeout: 10_000 });
    const now = (this.dependencies.now ?? (() => new Date()))();
    try {
      const phase = await db.transaction(tx => this.readRefreshPhase(tx, input, now));
      if (phase.status !== 'refresh') return phase;

      const refreshed = await this.requestOAuthRefresh({
        instanceUrl: phase.inputs.instanceUrl,
        clientId: phase.inputs.clientId,
        clientSecret: phase.inputs.clientSecret,
        refreshToken: phase.inputs.refreshToken,
      });
      return await db.transaction(tx =>
        this.commitRefresh(tx, input, phase.inputs, refreshed, now)
      );
    } catch {
      return { status: 'temporarily_unavailable' };
    }
  }

  private async loadRefreshRow(
    db: WorkerDb | WorkerTransaction,
    input: RefreshInput
  ): Promise<LoadedRefreshRow | null> {
    const [loaded] = await db
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
    if (!loaded) return null;

    const parsedCredential = GitLabOAuthCredentialRowSchema.safeParse(loaded.credential);
    const parsedMetadata = GitLabRefreshMetadataSchema.safeParse(loaded.metadata ?? {});
    if (!parsedCredential.success || !parsedMetadata.success) return null;
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
      return null;
    }
    return { credential, metadata, instanceUrl, integrationId: loaded.integrationId };
  }

  private async readRefreshPhase(
    tx: WorkerTransaction,
    input: RefreshInput,
    now: Date
  ): Promise<RefreshPhase> {
    const loaded = await this.loadRefreshRow(tx, input);
    if (!loaded) return { status: 'reconnect_required' };
    const { credential, metadata, instanceUrl } = loaded;

    if (
      credential.credential_version !== input.credential.credential_version ||
      (credential.access_token_expires_at &&
        new Date(credential.access_token_expires_at).getTime() - now.getTime() > REFRESH_BUFFER_MS)
    ) {
      return this.readCurrentCredential(credential, input);
    }

    const refreshToken = credential.refresh_token_encrypted
      ? await this.decryptOAuthSecret(credential, input, 'refresh')
      : { status: 'unreadable' as const };
    if (refreshToken.status === 'temporarily_unavailable') {
      return { status: 'temporarily_unavailable' };
    }
    if (refreshToken.status !== 'available') return { status: 'reconnect_required' };

    const clientId = metadata.client_id ?? (await resolveSecret(this.env.GITLAB_CLIENT_ID));
    let clientSecret: string | null;
    if (metadata.client_id) {
      if (!credential.oauth_client_secret_encrypted) return { status: 'reconnect_required' };
      const customSecret = await this.decryptOAuthSecret(credential, input, 'oauth-client-secret');
      if (customSecret.status === 'temporarily_unavailable') {
        return { status: 'temporarily_unavailable' };
      }
      if (customSecret.status !== 'available') return { status: 'reconnect_required' };
      clientSecret = customSecret.token;
    } else {
      clientSecret = await resolveSecret(this.env.GITLAB_CLIENT_SECRET);
    }
    if (!clientId || !clientSecret) return { status: 'temporarily_unavailable' };

    return {
      status: 'refresh',
      inputs: {
        credential,
        metadata,
        instanceUrl,
        clientId,
        clientSecret,
        refreshToken: refreshToken.token,
      },
    };
  }

  private async commitRefresh(
    tx: WorkerTransaction,
    input: RefreshInput,
    inputs: RefreshInputs,
    refreshed: OAuthProviderRefreshResult,
    now: Date
  ): Promise<RefreshResult> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`gitlab-integration:${input.parent.integrationId}`}, 0))`
    );
    const loaded = await this.loadRefreshRow(tx, input);
    if (!loaded) return { status: 'reconnect_required' };
    const credential = loaded.credential;
    if (credential.credential_version !== inputs.credential.credential_version) {
      // A concurrent refresh committed new secrets while this request waited on
      // the token endpoint. Its credential is current and healthy, so return it
      // instead of racing the version fence below.
      return this.readCurrentCredential(credential, input);
    }

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
    const [accessTokenEncrypted, refreshTokenEncrypted, clientSecretEncrypted] = await Promise.all([
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
      inputs.metadata.client_id
        ? this.encryptOAuthSecret(
            inputs.clientSecret,
            credential,
            input,
            'oauth-client-secret',
            nextVersion
          )
        : Promise.resolve(null),
    ]);
    if (
      accessTokenEncrypted.status !== 'available' ||
      refreshTokenEncrypted.status !== 'available' ||
      (clientSecretEncrypted !== null && clientSecretEncrypted.status !== 'available')
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
        ...(clientSecretEncrypted
          ? { oauth_client_secret_encrypted: clientSecretEncrypted.ciphertext }
          : {}),
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
  }

  private async readCurrentCredential(
    credential: LoadedRefreshRow['credential'],
    input: RefreshInput
  ): Promise<RefreshResult> {
    const decrypted = await this.decryptOAuthSecret(credential, input, 'access');
    if (decrypted.status === 'available') {
      return {
        status: 'available',
        token: decrypted.token,
        credentialVersion: credential.credential_version,
      };
    }
    return decrypted.status === 'temporarily_unavailable'
      ? { status: 'temporarily_unavailable' }
      : { status: 'reconnect_required' };
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
        // Bounded deadline for the token request; it covers the body read below,
        // which shares this signal.
        signal: AbortSignal.timeout(GITLAB_OAUTH_REFRESH_TIMEOUT_MS),
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
    kind: 'access' | 'refresh' | 'oauth-client-secret',
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
