import {
  decryptKeyedEnvelope,
  encryptKeyedEnvelope,
  EncryptionConfigurationError,
} from '@kilocode/encryption';
import { getWorkerDb } from '@kilocode/db/client';
import { user_github_app_tokens } from '@kilocode/db/schema';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

export type GitAuthorConfig = {
  name: string;
  email: string;
};

export type ManagedGitHubFallbackReason =
  | 'no_user_authorization'
  | 'revoked'
  | 'refresh_failed'
  | 'insufficient_user_access'
  | 'credential_unreadable'
  | 'credential_configuration_error';

export type UserAuthorizationSelection =
  | { selected: true; token: string; gitAuthor: GitAuthorConfig }
  | { selected: false; reason: ManagedGitHubFallbackReason };

const TOKEN_SCHEME = 'github-user-token-rsa-aes-256-gcm';
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const RefreshResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1),
  refresh_token_expires_in: z.number().positive(),
});
const RefreshErrorResponseSchema = z.object({ error: z.literal('bad_refresh_token') });
const RepositoryAccessSchema = z.object({
  permissions: z.object({ push: z.boolean() }),
});

type AuthorizationRow = typeof user_github_app_tokens.$inferSelect;
type WorkerDb = ReturnType<typeof getWorkerDb>;
type WorkerTransaction = Parameters<Parameters<WorkerDb['transaction']>[0]>[0];
type GitHubUserAuthorizationEnv = CloudflareEnv & {
  USER_GITHUB_APP_TOKEN_ACTIVE_KEY_ID?: string;
  USER_GITHUB_APP_TOKEN_ACTIVE_PUBLIC_KEY?: string;
  USER_GITHUB_APP_TOKEN_ACTIVE_PRIVATE_KEY?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
};
type CredentialKind = 'access' | 'refresh';
type RevokeResult = 'revoked' | 'token_invalid';
type DisconnectRefreshResult = AuthorizationRow | 'terminal_refresh_token' | null;

class CredentialSelectionError extends Error {
  constructor(readonly reason: 'credential_unreadable' | 'credential_configuration_error') {
    super(reason);
    this.name = 'CredentialSelectionError';
  }
}

export class GitHubUserAuthorizationService {
  constructor(private env: GitHubUserAuthorizationEnv) {}

  async selectUserAuthorization(params: {
    userId: string;
    githubRepo: string;
  }): Promise<UserAuthorizationSelection> {
    if (!this.env.HYPERDRIVE) {
      return { selected: false, reason: 'refresh_failed' };
    }
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString, { statement_timeout: 10_000 });
    let [authorization] = await db
      .select()
      .from(user_github_app_tokens)
      .where(
        and(
          eq(user_github_app_tokens.kilo_user_id, params.userId),
          eq(user_github_app_tokens.github_app_type, 'standard')
        )
      )
      .limit(1);
    if (!authorization) return { selected: false, reason: 'no_user_authorization' };
    if (authorization.revoked_at) return { selected: false, reason: 'revoked' };

    try {
      if (
        new Date(authorization.access_token_expires_at).getTime() - Date.now() <
        EXPIRY_BUFFER_MS
      ) {
        const refreshed = await this.refreshAuthorizationWithLock(db, authorization);
        if (!refreshed) return { selected: false, reason: 'refresh_failed' };
        authorization = refreshed;
      }

      const token = this.decryptCredential(authorization, 'access');
      const repoParts = params.githubRepo.split('/');
      const endpoint = `https://api.github.com/repos/${encodeURIComponent(repoParts[0])}/${encodeURIComponent(repoParts[1])}`;
      let response: Response;
      try {
        response = await fetch(endpoint, {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'Kilo-Git-Token-Service',
          },
        });
      } catch {
        return { selected: false, reason: 'insufficient_user_access' };
      }
      if (response.status === 401) {
        await this.revokeCurrentGeneration(db, authorization, 'github_token_rejected');
        return { selected: false, reason: 'revoked' };
      }
      if (!response.ok) return { selected: false, reason: 'insufficient_user_access' };

      const repositoryAccess = RepositoryAccessSchema.safeParse(await response.json());
      if (!repositoryAccess.success || !repositoryAccess.data.permissions.push) {
        return { selected: false, reason: 'insufficient_user_access' };
      }

      await db
        .update(user_github_app_tokens)
        .set({ last_used_at: new Date().toISOString() })
        .where(eq(user_github_app_tokens.id, authorization.id));
      return {
        selected: true,
        token,
        gitAuthor: {
          name: authorization.github_login,
          email: `${authorization.github_user_id}+${authorization.github_login}@users.noreply.github.com`,
        },
      };
    } catch (error) {
      if (error instanceof CredentialSelectionError) {
        return { selected: false, reason: error.reason };
      }
      throw error;
    }
  }

  async disconnectUserAuthorization(kiloUserId: string): Promise<void> {
    const db = this.getDatabase();
    const [candidate] = await db
      .select()
      .from(user_github_app_tokens)
      .where(
        and(
          eq(user_github_app_tokens.kilo_user_id, kiloUserId),
          eq(user_github_app_tokens.github_app_type, 'standard')
        )
      )
      .limit(1);
    if (!candidate) return;

    const refreshedAuthorization = await db.transaction(async tx => {
      await this.lockAuthorizationGrant(tx, candidate.github_user_id);
      const [authorization] = await tx
        .select()
        .from(user_github_app_tokens)
        .where(
          and(
            eq(user_github_app_tokens.kilo_user_id, kiloUserId),
            eq(user_github_app_tokens.github_app_type, 'standard')
          )
        )
        .limit(1);
      if (!authorization) return null;
      if (authorization.github_user_id !== candidate.github_user_id) {
        throw new Error('GitHub authorization changed during disconnect');
      }
      if (authorization.revoked_at) {
        await this.deleteCurrentAuthorization(tx, authorization);
        return null;
      }

      const accessTokenExpired =
        new Date(authorization.access_token_expires_at).getTime() <= Date.now();
      if (!accessTokenExpired) {
        const accessToken = this.decryptCredential(authorization, 'access');
        if ((await this.revokeAuthorizationOnGitHub(accessToken)) === 'revoked') {
          await this.deleteCurrentAuthorization(tx, authorization);
          return null;
        }
      }

      const refreshed = await this.refreshAuthorizationForDisconnect(tx, authorization);
      if (refreshed === 'terminal_refresh_token' && accessTokenExpired) {
        await this.deleteCurrentAuthorization(tx, authorization);
        return null;
      }
      if (!refreshed || refreshed === 'terminal_refresh_token') {
        throw new Error('GitHub authorization grant could not be revoked');
      }
      return refreshed;
    });
    if (!refreshedAuthorization) return;

    await db.transaction(async tx => {
      await this.lockAuthorizationGrant(tx, refreshedAuthorization.github_user_id);
      const [authorization] = await tx
        .select()
        .from(user_github_app_tokens)
        .where(
          and(
            eq(user_github_app_tokens.kilo_user_id, kiloUserId),
            eq(user_github_app_tokens.github_app_type, 'standard')
          )
        )
        .limit(1);
      if (!authorization) return;
      if (
        authorization.id !== refreshedAuthorization.id ||
        authorization.credential_version !== refreshedAuthorization.credential_version
      ) {
        throw new Error('GitHub authorization changed during disconnect');
      }
      const refreshedAccessToken = this.decryptCredential(authorization, 'access');
      if ((await this.revokeAuthorizationOnGitHub(refreshedAccessToken)) !== 'revoked') {
        throw new Error('GitHub authorization grant could not be revoked');
      }
      await this.deleteCurrentAuthorization(tx, authorization);
    });
  }

  private async lockAuthorizationGrant(db: WorkerTransaction, githubUserId: string): Promise<void> {
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${this.authorizationGrantLockKey(githubUserId)}))`
    );
  }

  private authorizationGrantLockKey(githubUserId: string): string {
    return `github-user-authorization:standard:${githubUserId}`;
  }

  private getDatabase(): WorkerDb {
    if (!this.env.HYPERDRIVE) {
      throw new EncryptionConfigurationError('GitHub authorization database is not configured');
    }
    return getWorkerDb(this.env.HYPERDRIVE.connectionString, { statement_timeout: 10_000 });
  }

  private decryptCredential(authorization: AuthorizationRow, kind: CredentialKind): string {
    let keys: Parameters<typeof decryptKeyedEnvelope>[2];
    try {
      keys = this.getDecryptionKeys();
    } catch {
      throw new CredentialSelectionError('credential_configuration_error');
    }

    try {
      return decryptKeyedEnvelope(
        kind === 'access'
          ? authorization.access_token_encrypted
          : authorization.refresh_token_encrypted,
        TOKEN_SCHEME,
        keys,
        this.getCredentialAad(authorization, kind)
      );
    } catch {
      throw new CredentialSelectionError('credential_unreadable');
    }
  }

  private getDecryptionKeys(): Parameters<typeof decryptKeyedEnvelope>[2] {
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

  private encryptCredential(
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

  private getCredentialAad(authorization: AuthorizationRow, kind: CredentialKind): string {
    return `github-user-authorization:v1:${authorization.kilo_user_id}:${authorization.github_app_type}:${authorization.github_user_id}:${kind}`;
  }

  private decodePemKey(encodedKey: string): string {
    const pemKey = Buffer.from(encodedKey, 'base64').toString('utf8');
    if (!pemKey) {
      throw new EncryptionConfigurationError('GitHub user-token key is invalid');
    }
    return pemKey;
  }

  private validatePrivateKey(privateKeyPem: string): void {
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

  private async refreshAuthorizationWithLock(
    db: WorkerDb,
    candidate: AuthorizationRow
  ): Promise<AuthorizationRow | null> {
    return db.transaction(async tx => {
      await this.lockAuthorizationGrant(tx, candidate.github_user_id);
      const [authorization] = await tx
        .select()
        .from(user_github_app_tokens)
        .where(eq(user_github_app_tokens.id, candidate.id))
        .limit(1);
      if (!authorization || authorization.revoked_at) return null;
      if (
        authorization.credential_version !== candidate.credential_version ||
        new Date(authorization.access_token_expires_at).getTime() - Date.now() >= EXPIRY_BUFFER_MS
      ) {
        return authorization;
      }
      return this.refreshAuthorization(tx, authorization);
    });
  }

  private async refreshAuthorization(
    db: WorkerTransaction,
    authorization: AuthorizationRow
  ): Promise<AuthorizationRow | null> {
    const clientId = this.env.GITHUB_APP_CLIENT_ID;
    const clientSecret = this.env.GITHUB_APP_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
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
      });
    } catch {
      return null;
    }

    if (!response.ok) return null;
    const parsed = RefreshResponseSchema.safeParse(await response.json());
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
    if (updated) return updated;

    const [winner] = await db
      .select()
      .from(user_github_app_tokens)
      .where(eq(user_github_app_tokens.id, authorization.id))
      .limit(1);
    return winner && !winner.revoked_at ? winner : null;
  }

  private async revokeAuthorizationOnGitHub(accessToken: string): Promise<RevokeResult> {
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
    });
    if (response.ok || response.status === 404) return 'revoked';
    if (response.status === 401 || response.status === 403 || response.status === 422) {
      return 'token_invalid';
    }
    throw new Error(`GitHub authorization revocation failed (${response.status})`);
  }

  private async refreshAuthorizationForDisconnect(
    db: WorkerTransaction,
    authorization: AuthorizationRow
  ): Promise<DisconnectRefreshResult> {
    const clientId = this.env.GITHUB_APP_CLIENT_ID;
    const clientSecret = this.env.GITHUB_APP_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    if (new Date(authorization.refresh_token_expires_at).getTime() <= Date.now()) {
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

  private async deleteCurrentAuthorization(
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

  private async revokeCurrentGeneration(
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
