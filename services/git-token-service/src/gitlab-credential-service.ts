import {
  GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
  GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
  GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_SCHEME,
  GitLabOAuthCredentialRowSchema,
  GitLabPersonalAccessTokenCredentialRowSchema,
  GitLabProjectAccessTokenCredentialRowSchema,
  buildGitLabOAuthCredentialAad,
  buildGitLabPersonalAccessTokenAad,
  buildGitLabProjectAccessTokenAad,
  type GitLabCredentialOwner,
  type GitLabOAuthCredentialRow,
} from '@kilocode/worker-utils/gitlab-credential';
import { normalizeGitLabInstanceUrl } from './gitlab-url.js';
import type { GitLabCredentialCrypto } from './gitlab-credential-crypto.js';

export type GitLabCredentialActor = { userId: string; orgId?: string };

export type GitLabCredentialSelector =
  | { credential: 'integration'; integrationId: string }
  | { credential: 'project-exact'; integrationId: string; projectId: string };

export type GitLabCredentialParent = {
  integrationId: string;
  platform: string;
  integrationType: string;
  integrationStatus: string | null;
  ownedByUserId: string | null;
  ownedByOrganizationId: string | null;
  providerBaseUrl: string | null;
  providerSubjectId?: string | null;
  providerSubjectLogin?: string | null;
};

export type GitLabCredentialFence = {
  credentialTable: 'oauth' | 'access-token';
  integrationId: string;
  credentialId: string;
  credentialVersion: number;
};

export type GitLabCredentialStore = {
  findCredential(input: {
    actor: GitLabCredentialActor;
    selector: GitLabCredentialSelector;
  }): Promise<{ parent: GitLabCredentialParent; credential: unknown } | null>;
  hasProjectCredentialCandidates(input: {
    actor: GitLabCredentialActor;
    integrationId: string;
  }): Promise<boolean>;
  markUsed(fence: GitLabCredentialFence, at: string): Promise<boolean>;
};

export type GitLabCredentialResult =
  | {
      status: 'available';
      token: string;
      instanceUrl: string;
      integrationId: string;
      glabIsOAuth2: boolean;
      credentialId: string;
      credentialVersion: number;
      source: { type: 'integration' } | { type: 'project'; projectId: string };
    }
  | { status: 'not_connected' }
  | { status: 'credential_absent' }
  | { status: 'reconnect_required' }
  | { status: 'temporarily_unavailable' };

export type GitLabOAuthCredentialRefreshResult =
  | { status: 'available'; token: string; credentialVersion: number }
  | { status: 'reconnect_required' }
  | { status: 'temporarily_unavailable' };

export type GitLabOAuthCredentialRefresher = {
  refresh(input: {
    actor: GitLabCredentialActor;
    parent: GitLabCredentialParent;
    owner: GitLabCredentialOwner;
    credential: GitLabOAuthCredentialRow;
  }): Promise<GitLabOAuthCredentialRefreshResult>;
};

const OAUTH_REFRESH_BUFFER_MS = 5 * 60 * 1000;

function needsOAuthRefresh(expiresAt: string | null): boolean {
  return !expiresAt || new Date(expiresAt).getTime() - Date.now() <= OAUTH_REFRESH_BUFFER_MS;
}

function parentOwner(
  parent: GitLabCredentialParent,
  actor: GitLabCredentialActor
): GitLabCredentialOwner | null {
  if (actor.orgId) {
    if (parent.ownedByOrganizationId !== actor.orgId || parent.ownedByUserId !== null) {
      return null;
    }
    return { type: 'org', id: actor.orgId };
  }
  if (parent.ownedByUserId !== actor.userId || parent.ownedByOrganizationId !== null) {
    return null;
  }
  return { type: 'user', id: actor.userId };
}

function canonicalProviderBaseUrl(value: string | null): string | null {
  if (!value) return null;
  const normalized = normalizeGitLabInstanceUrl(value);
  return normalized === value ? normalized : null;
}

export class GitLabCredentialService {
  constructor(
    private store: GitLabCredentialStore,
    private crypto: Pick<GitLabCredentialCrypto, 'decrypt'>,
    private oauthRefresher?: GitLabOAuthCredentialRefresher
  ) {}

  hasProjectCredentialCandidates(
    actor: GitLabCredentialActor,
    integrationId: string
  ): Promise<boolean> {
    return this.store.hasProjectCredentialCandidates({ actor, integrationId });
  }

  async getCredential(
    actor: GitLabCredentialActor,
    selector: GitLabCredentialSelector
  ): Promise<GitLabCredentialResult> {
    let loaded: Awaited<ReturnType<GitLabCredentialStore['findCredential']>>;
    try {
      loaded = await this.store.findCredential({ actor, selector });
    } catch {
      return { status: 'temporarily_unavailable' };
    }
    if (!loaded) return { status: 'not_connected' };

    const { parent } = loaded;
    const owner = parentOwner(parent, actor);
    const instanceUrl = canonicalProviderBaseUrl(parent.providerBaseUrl);
    if (
      !owner ||
      !instanceUrl ||
      parent.integrationId !== selector.integrationId ||
      parent.platform !== 'gitlab' ||
      parent.integrationStatus !== 'active'
    ) {
      return { status: 'reconnect_required' };
    }
    if (loaded.credential === null || loaded.credential === undefined) {
      return { status: 'credential_absent' };
    }

    if (selector.credential === 'project-exact') {
      const parsed = GitLabProjectAccessTokenCredentialRowSchema.safeParse(loaded.credential);
      if (!parsed.success) return { status: 'reconnect_required' };
      const credential = parsed.data;
      if (
        credential.platform_integration_id !== parent.integrationId ||
        credential.provider_resource_id !== selector.projectId ||
        credential.provider_base_url !== instanceUrl
      ) {
        return { status: 'reconnect_required' };
      }

      const decrypted = await this.crypto.decrypt({
        ciphertext: credential.token_encrypted,
        scheme: GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_SCHEME,
        aad: buildGitLabProjectAccessTokenAad({
          credentialId: credential.id,
          integrationId: credential.platform_integration_id,
          providerBaseUrl: credential.provider_base_url,
          owner,
          providerResourceId: credential.provider_resource_id,
          credentialVersion: credential.credential_version,
        }),
      });
      if (decrypted.status === 'temporarily_unavailable') return decrypted;
      if (decrypted.status === 'unreadable') return { status: 'reconnect_required' };

      const fence = {
        credentialTable: 'access-token' as const,
        integrationId: parent.integrationId,
        credentialId: credential.id,
        credentialVersion: credential.credential_version,
      };
      try {
        if (!(await this.store.markUsed(fence, new Date().toISOString()))) {
          return { status: 'reconnect_required' };
        }
      } catch {
        return { status: 'temporarily_unavailable' };
      }
      return {
        status: 'available',
        token: decrypted.token,
        instanceUrl,
        integrationId: parent.integrationId,
        glabIsOAuth2: false,
        credentialId: credential.id,
        credentialVersion: credential.credential_version,
        source: { type: 'project', projectId: credential.provider_resource_id },
      };
    }

    if (parent.integrationType === 'oauth') {
      const parsed = GitLabOAuthCredentialRowSchema.safeParse(loaded.credential);
      if (!parsed.success) return { status: 'reconnect_required' };
      const credential = parsed.data;
      if (
        credential.platform_integration_id !== parent.integrationId ||
        credential.provider_base_url !== instanceUrl ||
        credential.revoked_at !== null ||
        (parent.providerSubjectId !== undefined &&
          credential.provider_subject_id !== parent.providerSubjectId) ||
        (parent.providerSubjectLogin !== undefined &&
          credential.provider_subject_login !== parent.providerSubjectLogin) ||
        (owner.type === 'user' && credential.authorized_by_user_id !== owner.id)
      ) {
        return { status: 'reconnect_required' };
      }

      if (needsOAuthRefresh(credential.access_token_expires_at)) {
        if (!this.oauthRefresher) return { status: 'temporarily_unavailable' };
        let refreshed: GitLabOAuthCredentialRefreshResult;
        try {
          refreshed = await this.oauthRefresher.refresh({ actor, parent, owner, credential });
        } catch {
          return { status: 'temporarily_unavailable' };
        }
        if (refreshed.status !== 'available') return refreshed;
        return {
          status: 'available',
          token: refreshed.token,
          instanceUrl,
          integrationId: parent.integrationId,
          glabIsOAuth2: true,
          credentialId: credential.id,
          credentialVersion: refreshed.credentialVersion,
          source: { type: 'integration' },
        };
      }

      const decrypted = await this.crypto.decrypt({
        ciphertext: credential.access_token_encrypted,
        scheme: GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
        aad: buildGitLabOAuthCredentialAad({
          credentialId: credential.id,
          integrationId: credential.platform_integration_id,
          providerBaseUrl: credential.provider_base_url,
          owner,
          authorizedByUserId: credential.authorized_by_user_id,
          credentialVersion: credential.credential_version,
          kind: 'access',
        }),
      });
      if (decrypted.status === 'temporarily_unavailable') return decrypted;
      if (decrypted.status === 'unreadable') return { status: 'reconnect_required' };

      const fence = {
        credentialTable: 'oauth' as const,
        integrationId: parent.integrationId,
        credentialId: credential.id,
        credentialVersion: credential.credential_version,
      };
      try {
        if (!(await this.store.markUsed(fence, new Date().toISOString()))) {
          return { status: 'reconnect_required' };
        }
      } catch {
        return { status: 'temporarily_unavailable' };
      }
      return {
        status: 'available',
        token: decrypted.token,
        instanceUrl,
        integrationId: parent.integrationId,
        glabIsOAuth2: true,
        credentialId: credential.id,
        credentialVersion: credential.credential_version,
        source: { type: 'integration' },
      };
    }

    if (parent.integrationType !== 'pat') return { status: 'reconnect_required' };

    const parsed = GitLabPersonalAccessTokenCredentialRowSchema.safeParse(loaded.credential);
    if (!parsed.success) return { status: 'reconnect_required' };
    const credential = parsed.data;
    if (
      credential.platform_integration_id !== parent.integrationId ||
      credential.provider_base_url !== instanceUrl ||
      (owner.type === 'user' && credential.authorized_by_user_id !== owner.id)
    ) {
      return { status: 'reconnect_required' };
    }

    const decrypted = await this.crypto.decrypt({
      ciphertext: credential.token_encrypted,
      scheme: GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
      aad: buildGitLabPersonalAccessTokenAad({
        credentialId: credential.id,
        integrationId: credential.platform_integration_id,
        providerBaseUrl: credential.provider_base_url,
        owner,
        authorizedByUserId: credential.authorized_by_user_id,
        credentialVersion: credential.credential_version,
      }),
    });
    if (decrypted.status === 'temporarily_unavailable') return decrypted;
    if (decrypted.status === 'unreadable') return { status: 'reconnect_required' };

    const fence = {
      credentialTable: 'access-token' as const,
      integrationId: parent.integrationId,
      credentialId: credential.id,
      credentialVersion: credential.credential_version,
    };
    try {
      if (!(await this.store.markUsed(fence, new Date().toISOString()))) {
        return { status: 'reconnect_required' };
      }
    } catch {
      return { status: 'temporarily_unavailable' };
    }

    return {
      status: 'available',
      token: decrypted.token,
      instanceUrl,
      integrationId: parent.integrationId,
      glabIsOAuth2: false,
      credentialId: credential.id,
      credentialVersion: credential.credential_version,
      source: { type: 'integration' },
    };
  }
}
