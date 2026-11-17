import {
  decryptKeyedEnvelope,
  encryptKeyedEnvelope,
  EncryptionConfigurationError,
} from '@kilocode/encryption';
import { lockGitHubGrant } from '@kilocode/db/github-identity';
import { getWorkerDb } from '@kilocode/db/client';
import { user_github_app_tokens } from '@kilocode/db/schema';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  claimRefreshLease,
  newRefreshLeaseAttemptId,
  releaseRefreshLease,
} from './lib/oauth-refresh-lease.js';

const TOKEN_SCHEME = 'github-user-token-rsa-aes-256-gcm';
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const RefreshResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1),
  refresh_token_expires_in: z.number().positive(),
});
const RefreshErrorResponseSchema = z.object({ error: z.literal('bad_refresh_token') });

export type AuthorizationRow = typeof user_github_app_tokens.$inferSelect;
type WorkerDb = ReturnType<typeof getWorkerDb>;
type WorkerTransaction = Parameters<Parameters<WorkerDb['transaction']>[0]>[0];
export type GitHubUserAuthorizationEnv = CloudflareEnv & {
  USER_GITHUB_APP_TOKEN_ACTIVE_KEY_ID?: string;
  USER_GITHUB_APP_TOKEN_ACTIVE_PUBLIC_KEY?: string;
  USER_GITHUB_APP_TOKEN_ACTIVE_PRIVATE_KEY?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_OAUTH_BASE_URL?: string;
  // Dev-only override that points the REST API at a local stub; absent in
  // production, where the probe uses real api.github.com.
  GITHUB_API_BASE_URL?: string;
};
type CredentialKind = 'access' | 'refresh';
type RevokeResult = 'revoked' | 'token_invalid';
type DisconnectRefreshResult = AuthorizationRow | 'terminal_refresh_token' | null;
type RefreshResult = 'refreshed' | 'transient_failure' | 'terminal_rejection';

const GITHUB_USER_AUTHORIZATION_REQUEST_TIMEOUT_MS = 10_000;

type AuthorizationRefreshInputs = {
  authorization: AuthorizationRow;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

type GitHubProviderRefreshResult =
  | { status: 'available'; data: z.infer<typeof RefreshResponseSchema> }
  | { status: 'terminal_rejection' }
  | { status: 'transient_failure' };
const DEFAULT_GITHUB_OAUTH_BASE_URL = 'https://github.com';

export class CredentialSelectionError extends Error {
  constructor(readonly reason: 'credential_unreadable' | 'credential_configuration_error') {
    super(reason);
    this.name = 'CredentialSelectionError';
  }
}

export class GitHubAppCredentialLifecycle {
  constructor(protected env: GitHubUserAuthorizationEnv) {}

  protected getDatabase(): WorkerDb {
    if (!this.env.HYPERDRIVE) {
      throw new EncryptionConfigurationError('GitHub authorization database is not configured');
    }
    return getWorkerDb(this.env.HYPERDRIVE.connectionString, { statement_timeout: 10_000 });
  }

  protected getGitHubOAuthBaseUrl(): string {
    const baseUrl = this.env.GITHUB_OAUTH_BASE_URL ?? DEFAULT_GITHUB_OAUTH_BASE_URL;
    let end = baseUrl.length;
    while (end > 0 && baseUrl[end - 1] === '/') {
      end -= 1;
    }
    return baseUrl.slice(0, end);
  }

  protected getGitHubOAuthAccessTokenUrl(): string {
    return `${this.getGitHubOAuthBaseUrl()}/login/oauth/access_token`;
  }

  protected decryptCredential(authorization: AuthorizationRow, kind: CredentialKind): string {
    let keys: Parameters<typeof decryptKeyedEnvelope>[2];
    try {
      keys = this.getDecryptionKeys();
    } catch {
      throw new CredentialSelectionError('credential_configuration_error');
    }

    try {
      const encrypted =
        kind === 'access'
          ? authorization.access_token_encrypted
          : authorization.refresh_token_encrypted;
      if (encrypted === null) throw new CredentialSelectionError('credential_unreadable');
      return decryptKeyedEnvelope(
        encrypted,

        TOKEN_SCHEME,
        keys,
        this.getCredentialAad(authorization, kind)
      );
    } catch {
      throw new CredentialSelectionError('credential_unreadable');
    }
  }

  protected getDecryptionKeys(): Parameters<typeof decryptKeyedEnvelope>[2] {
    const activeKeyId = this.env.USER_GITHUB_APP_TOKEN_ACTIVE_KEY_ID;
    const activePrivateKeyEncoded = this.env.USER_GITHUB_APP_TOKEN_ACTIVE_PRIVATE_KEY;
    if (!activeKeyId || !activePrivateKeyEncoded) {
      throw new EncryptionConfigurationError(
        'Active GitHub user-token private key is not configured'
      );
    }
    const activePrivateKey = this.decodePemKey(activePrivateKeyEncoded);
    this.validatePrivateKey(activePrivateKey);

    return { active: { keyId: activeKeyId, privateKeyPem: activePrivateKey } };
  }

  protected encryptCredential(
    value: string,
    authorization: AuthorizationRow,
    kind: CredentialKind
  ): string {
    const keyId = this.env.USER_GITHUB_APP_TOKEN_ACTIVE_KEY_ID;
    const publicKeyEncoded = this.env.USER_GITHUB_APP_TOKEN_ACTIVE_PUBLIC_KEY;
    if (!keyId || !publicKeyEncoded) {
      throw new CredentialSelectionError('credential_configuration_error');
    }
    try {
      const publicKeyPem = this.decodePemKey(publicKeyEncoded);
      const publicKey = createPublicKey(publicKeyPem);
      if (publicKey.asymmetricKeyType !== 'rsa') {
        throw new EncryptionConfigurationError('Active GitHub user-token public key must be RSA');
      }
      return encryptKeyedEnvelope(
        value,
        TOKEN_SCHEME,
        { keyId, publicKeyPem },
        this.getCredentialAad(authorization, kind)
      );
    } catch {
      throw new CredentialSelectionError('credential_configuration_error');
    }
  }

  protected getCredentialAad(authorization: AuthorizationRow, kind: CredentialKind): string {
    return `github-user-authorization:v1:${authorization.kilo_user_id}:${authorization.github_app_type}:${authorization.github_user_id}:${kind}`;
  }

  protected decodePemKey(encodedKey: string): string {
    const pemKey = Buffer.from(encodedKey, 'base64').toString('utf8');
    if (!pemKey) {
      throw new EncryptionConfigurationError('GitHub user-token key is invalid');
    }
    return pemKey;
  }

  protected validatePrivateKey(privateKeyPem: string): void {
    try {
      const privateKey = createPrivateKey(privateKeyPem);
      if (privateKey.asymmetricKeyType !== 'rsa') {
        throw new Error('Private key must be RSA');
      }
    } catch (error) {
      throw new EncryptionConfigurationError('GitHub user-token private key is invalid', {
        cause: error,
      });
    }
  }

  protected async refreshAuthorizationWithLock(
    db: WorkerDb,
    candidate: AuthorizationRow,
    options: { force?: boolean } = {}
  ): Promise<RefreshResult> {
    const attemptId = newRefreshLeaseAttemptId();
    const decision = await db.transaction(tx =>
      this.readRefreshDecision(tx, candidate, attemptId, options)
    );
    if (typeof decision !== 'object') return decision;

    const refreshed = await this.requestAuthorizationRefresh(decision.inputs);
    return db.transaction(tx => this.commitRefresh(tx, candidate, refreshed, attemptId));
  }

  protected async readRefreshDecision(
    tx: WorkerTransaction,
    candidate: AuthorizationRow,
    attemptId: string,
    options: { force?: boolean }
  ): Promise<{ status: 'refresh'; inputs: AuthorizationRefreshInputs } | RefreshResult> {
    const lease = { kind: 'user-github-app-token' as const, credentialId: candidate.id };
    const initial = await this.selectAuthorizationForRefresh(tx, candidate, options);
    if (typeof initial !== 'object') return initial;

    const clientId = this.env.GITHUB_APP_CLIENT_ID;
    const clientSecret = this.env.GITHUB_APP_CLIENT_SECRET;
    if (!clientId || !clientSecret) return 'transient_failure';
    // Only the attempt that holds the exchange lease may use the refresh token:
    // a second concurrent exchange would make one of the two attempts look like
    // a rejected credential.
    const claimed = await claimRefreshLease(tx, {
      ...lease,
      attemptId,
      providerRequestBudgetMs: GITHUB_USER_AUTHORIZATION_REQUEST_TIMEOUT_MS,
    });
    if (!claimed) return 'transient_failure';

    // The claim can wait for a holder that then commits, so re-read the row this
    // exchange will use and give the lease back when it is no longer the row to
    // refresh.
    const current = await this.selectAuthorizationForRefresh(tx, candidate, options);
    if (typeof current !== 'object') {
      await releaseRefreshLease(tx, { ...lease, attemptId });
      return current;
    }

    return {
      status: 'refresh',
      inputs: {
        authorization: current.authorization,
        clientId,
        clientSecret,
        refreshToken: this.decryptCredential(current.authorization, 'refresh'),
      },
    };
  }

  protected async selectAuthorizationForRefresh(
    tx: WorkerTransaction,
    candidate: AuthorizationRow,
    options: { force?: boolean }
  ): Promise<{ authorization: AuthorizationRow } | RefreshResult> {
    const [authorization] = await tx
      .select()
      .from(user_github_app_tokens)
      .where(eq(user_github_app_tokens.id, candidate.id))
      .limit(1);
    if (!authorization) return 'transient_failure';
    if (authorization.revoked_at) return 'terminal_rejection';
    if (authorization.credential_source !== 'github_app') return 'refreshed';
    if (authorization.credential_version !== candidate.credential_version) {
      // Another request already refreshed/rotated this grant. The current row is
      // healthy (present and not revoked), so accept the concurrent winner's
      // credential rather than failing: the caller re-reads the current row.
      return 'refreshed';
    }
    if (
      !options.force &&
      new Date(authorization.access_token_expires_at ?? 0).getTime() - Date.now() >=
        EXPIRY_BUFFER_MS
    ) {
      return 'refreshed';
    }
    return { authorization };
  }

  protected async requestAuthorizationRefresh(
    inputs: AuthorizationRefreshInputs
  ): Promise<GitHubProviderRefreshResult> {
    let response: Response;
    try {
      response = await fetch(this.getGitHubOAuthAccessTokenUrl(), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: inputs.clientId,
          client_secret: inputs.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: inputs.refreshToken,
        }),
        // Bounded deadline for the provider token request.
        signal: AbortSignal.timeout(GITHUB_USER_AUTHORIZATION_REQUEST_TIMEOUT_MS),
      });
    } catch {
      return { status: 'transient_failure' };
    }

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      return { status: 'transient_failure' };
    }
    if (RefreshErrorResponseSchema.safeParse(responseBody).success) {
      return { status: 'terminal_rejection' };
    }
    if (!response.ok) return { status: 'transient_failure' };
    const parsed = RefreshResponseSchema.safeParse(responseBody);
    return parsed.success
      ? { status: 'available', data: parsed.data }
      : { status: 'transient_failure' };
  }

  protected async commitRefresh(
    tx: WorkerTransaction,
    candidate: AuthorizationRow,
    refreshed: GitHubProviderRefreshResult,
    attemptId: string
  ): Promise<RefreshResult> {
    await lockGitHubGrant(tx, candidate.github_user_id);
    // Losing the lease means it expired mid-exchange and another attempt owns
    // the provider exchange, so this answer describes a generation that may no
    // longer be current: neither persist it nor report it as a rejection.
    const holdsLease = await releaseRefreshLease(tx, {
      kind: 'user-github-app-token',
      credentialId: candidate.id,
      attemptId,
    });
    if (!holdsLease) return 'transient_failure';
    const [authorization] = await tx
      .select()
      .from(user_github_app_tokens)
      .where(eq(user_github_app_tokens.id, candidate.id))
      .limit(1);
    if (!authorization) return 'transient_failure';
    if (authorization.revoked_at) return 'terminal_rejection';
    if (authorization.credential_source !== 'github_app') return 'refreshed';
    if (authorization.credential_version !== candidate.credential_version) {
      // A concurrent refresh committed the new secrets while this request
      // waited on the token endpoint: its credential is current and healthy.
      return 'refreshed';
    }
    if (refreshed.status !== 'available') return refreshed.status;

    const now = Date.now();
    const [updated] = await tx
      .update(user_github_app_tokens)
      .set({
        access_token_encrypted: this.encryptCredential(
          refreshed.data.access_token,
          authorization,
          'access'
        ),
        access_token_expires_at: new Date(now + refreshed.data.expires_in * 1000).toISOString(),
        refresh_token_encrypted: this.encryptCredential(
          refreshed.data.refresh_token,
          authorization,
          'refresh'
        ),
        refresh_token_expires_at: new Date(
          now + refreshed.data.refresh_token_expires_in * 1000
        ).toISOString(),
        credential_version: sql`${user_github_app_tokens.credential_version} + 1`,
        last_used_at: new Date().toISOString(),
      })
      .where(
        and(
          eq(user_github_app_tokens.id, authorization.id),
          eq(user_github_app_tokens.credential_version, authorization.credential_version),
          isNull(user_github_app_tokens.revoked_at)
        )
      )
      .returning();
    if (updated) return 'refreshed';

    const [winner] = await tx
      .select()
      .from(user_github_app_tokens)
      .where(eq(user_github_app_tokens.id, authorization.id))
      .limit(1);
    if (winner && !winner.revoked_at) return 'refreshed';
    return 'transient_failure';
  }

  protected async revokeAuthorizationOnGitHub(accessToken: string): Promise<RevokeResult> {
    const clientId = this.env.GITHUB_APP_CLIENT_ID;
    const clientSecret = this.env.GITHUB_APP_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new EncryptionConfigurationError(
        'GitHub App revocation credentials are not configured'
      );
    }
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await fetch(`https://api.github.com/applications/${clientId}/grant`, {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Kilo-Git-Token-Service',
      },
      body: JSON.stringify({ access_token: accessToken }),
      // Bounded deadline for the provider revocation request.
      signal: AbortSignal.timeout(GITHUB_USER_AUTHORIZATION_REQUEST_TIMEOUT_MS),
    });
    if (response.ok || response.status === 404) return 'revoked';
    if (response.status === 401 || response.status === 403 || response.status === 422) {
      return 'token_invalid';
    }
    throw new Error(`GitHub authorization revocation failed (${response.status})`);
  }

  protected async refreshAuthorizationForDisconnect(
    db: WorkerTransaction,
    authorization: AuthorizationRow
  ): Promise<DisconnectRefreshResult> {
    const clientId = this.env.GITHUB_APP_CLIENT_ID;
    const clientSecret = this.env.GITHUB_APP_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    if (new Date(authorization.refresh_token_expires_at ?? 0).getTime() <= Date.now()) {
      return 'terminal_refresh_token';
    }
    const refreshToken = this.decryptCredential(authorization, 'refresh');
    let response: Response;
    try {
      response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
        // Bounded deadline for the provider token request.
        signal: AbortSignal.timeout(GITHUB_USER_AUTHORIZATION_REQUEST_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      return null;
    }
    if (RefreshErrorResponseSchema.safeParse(responseBody).success) {
      return 'terminal_refresh_token';
    }
    if (!response.ok) return null;
    const parsed = RefreshResponseSchema.safeParse(responseBody);
    if (!parsed.success) return null;

    const now = Date.now();
    const [updated] = await db
      .update(user_github_app_tokens)
      .set({
        access_token_encrypted: this.encryptCredential(
          parsed.data.access_token,
          authorization,
          'access'
        ),
        access_token_expires_at: new Date(now + parsed.data.expires_in * 1000).toISOString(),
        refresh_token_encrypted: this.encryptCredential(
          parsed.data.refresh_token,
          authorization,
          'refresh'
        ),
        refresh_token_expires_at: new Date(
          now + parsed.data.refresh_token_expires_in * 1000
        ).toISOString(),
        credential_version: sql`${user_github_app_tokens.credential_version} + 1`,
        last_used_at: new Date().toISOString(),
      })
      .where(
        and(
          eq(user_github_app_tokens.id, authorization.id),
          eq(user_github_app_tokens.credential_version, authorization.credential_version),
          isNull(user_github_app_tokens.revoked_at)
        )
      )
      .returning();
    if (!updated) {
      throw new Error('GitHub authorization changed during disconnect');
    }
    return updated;
  }

  protected async deleteCurrentAuthorization(
    db: WorkerTransaction,
    authorization: AuthorizationRow
  ): Promise<void> {
    const deleted = await db
      .delete(user_github_app_tokens)
      .where(
        and(
          eq(user_github_app_tokens.id, authorization.id),
          eq(user_github_app_tokens.credential_version, authorization.credential_version)
        )
      )
      .returning({ id: user_github_app_tokens.id });
    if (deleted.length === 0) {
      const [current] = await db
        .select()
        .from(user_github_app_tokens)
        .where(eq(user_github_app_tokens.id, authorization.id))
        .limit(1);
      if (current) throw new Error('GitHub authorization changed during disconnect');
    }
  }

  protected async revokeCurrentGeneration(
    db: WorkerDb,
    authorization: AuthorizationRow,
    reason: string
  ): Promise<void> {
    await db
      .update(user_github_app_tokens)
      .set({ revoked_at: new Date().toISOString(), revocation_reason: reason })
      .where(
        and(
          eq(user_github_app_tokens.id, authorization.id),
          eq(user_github_app_tokens.credential_version, authorization.credential_version),
          isNull(user_github_app_tokens.revoked_at)
        )
      );
  }
}
