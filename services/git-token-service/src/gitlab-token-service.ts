import { DEFAULT_GITLAB_INSTANCE_URL } from './gitlab-constants.js';
import type { GitLabIntegrationMetadata } from './gitlab-lookup-service.js';
import type {
  GitLabLegacyOAuthPromotionResult,
  GitLabOAuthCredentialRefresher,
} from './gitlab-oauth-credential-refresher.js';
import { normalizeGitLabInstanceUrl } from './gitlab-url.js';

export type GitLabTokenSuccess = {
  success: true;
  token: string;
  instanceUrl: string;
};

export type GitLabTokenFailure = {
  success: false;
  reason:
    | 'no_token'
    | 'token_refresh_failed'
    | 'token_expired_no_refresh'
    | 'invalid_instance_url'
    | 'encrypted_credential_available';
};

export type GitLabTokenResult = GitLabTokenSuccess | GitLabTokenFailure;

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

function isTokenExpired(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return true;
  return Date.now() >= new Date(expiresAt).getTime() - REFRESH_BUFFER_MS;
}

function mapPromotionResult(result: GitLabLegacyOAuthPromotionResult): GitLabTokenResult {
  switch (result.status) {
    case 'available':
      return { success: true, token: result.token, instanceUrl: result.instanceUrl };
    case 'encrypted_credential_available':
      return { success: false, reason: 'encrypted_credential_available' };
    case 'reconnect_required':
      return { success: false, reason: 'token_expired_no_refresh' };
    case 'temporarily_unavailable':
      return { success: false, reason: 'token_refresh_failed' };
  }
}

export class GitLabTokenService {
  constructor(
    _env: object,
    private legacyOAuthPromoter?: Pick<GitLabOAuthCredentialRefresher, 'promoteLegacy'>
  ) {}

  async getToken(
    integrationId: string,
    metadata: GitLabIntegrationMetadata,
    actor?: { userId: string; orgId?: string }
  ): Promise<GitLabTokenResult> {
    const instanceUrl = normalizeGitLabInstanceUrl(
      metadata.gitlab_instance_url || DEFAULT_GITLAB_INSTANCE_URL
    );
    if (!instanceUrl) return { success: false, reason: 'invalid_instance_url' };
    if (!metadata.access_token) return { success: false, reason: 'no_token' };
    if (metadata.auth_type === 'pat') {
      return { success: true, token: metadata.access_token, instanceUrl };
    }
    if (!isTokenExpired(metadata.token_expires_at)) {
      return { success: true, token: metadata.access_token, instanceUrl };
    }
    if (!metadata.refresh_token) return { success: false, reason: 'token_expired_no_refresh' };
    if (!actor || !this.legacyOAuthPromoter) {
      return { success: false, reason: 'token_refresh_failed' };
    }
    return mapPromotionResult(
      await this.legacyOAuthPromoter.promoteLegacy({ actor, integrationId })
    );
  }
}
