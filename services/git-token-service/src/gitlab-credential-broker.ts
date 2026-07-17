import type {
  GitLabCredentialActor,
  GitLabCredentialResult,
  GitLabCredentialSelector,
} from './gitlab-credential-service.js';
import type { GitLabIntegrationMetadata, GitLabLookupResult } from './gitlab-lookup-service.js';
import { DEFAULT_GITLAB_INSTANCE_URL } from './gitlab-constants.js';
import type { GitLabTokenResult } from './gitlab-token-service.js';
import { normalizeGitLabInstanceUrl } from './gitlab-url.js';

export type GitLabCredentialBrokerResult =
  | {
      status: 'available';
      token: string;
      instanceUrl: string;
      glabIsOAuth2: boolean;
      integrationId: string;
      credentialId?: string;
      credentialVersion?: number;
      source: { type: 'integration' } | { type: 'project'; projectId: string };
    }
  | { status: 'invalid_request' }
  | { status: 'not_connected' }
  | { status: 'reconnect_required' }
  | { status: 'temporarily_unavailable' };

type GitLabCredentialBrokerDependencies = {
  findIntegration(actor: GitLabCredentialActor, integrationId: string): Promise<GitLabLookupResult>;
  getLegacyIntegrationToken(
    actor: GitLabCredentialActor,
    integrationId: string,
    metadata: GitLabIntegrationMetadata
  ): Promise<GitLabTokenResult>;
  getEncryptedCredential(
    actor: GitLabCredentialActor,
    selector: GitLabCredentialSelector
  ): Promise<GitLabCredentialResult>;
  hasProjectCredentialCandidates(
    actor: GitLabCredentialActor,
    integrationId: string
  ): Promise<boolean>;
  reportFallback(event: {
    integrationId: string;
    credential: GitLabCredentialSelector['credential'];
    status: string;
  }): void;
};

function mapLookupFailure(result: Exclude<GitLabLookupResult, { success: true }>) {
  switch (result.reason) {
    case 'database_not_configured':
      return { status: 'temporarily_unavailable' } as const;
    case 'invalid_org_id':
      return { status: 'invalid_request' } as const;
    case 'no_integration_found':
      return { status: 'not_connected' } as const;
  }
}

function mapLegacyFailure(result: Exclude<GitLabTokenResult, { success: true }>) {
  return result.reason === 'token_refresh_failed'
    ? ({ status: 'temporarily_unavailable' } as const)
    : ({ status: 'reconnect_required' } as const);
}

export class GitLabCredentialBroker {
  constructor(private dependencies: GitLabCredentialBrokerDependencies) {}

  hasProjectCredentialCandidates(
    actor: GitLabCredentialActor,
    integrationId: string
  ): Promise<boolean> {
    return this.dependencies.hasProjectCredentialCandidates(actor, integrationId);
  }

  async resolveCredential(
    actor: GitLabCredentialActor,
    selector: GitLabCredentialSelector
  ): Promise<GitLabCredentialBrokerResult> {
    const encrypted = await this.dependencies.getEncryptedCredential(actor, selector);
    if (encrypted.status === 'available') {
      return {
        status: 'available',
        token: encrypted.token,
        instanceUrl: encrypted.instanceUrl,
        glabIsOAuth2: encrypted.glabIsOAuth2,
        integrationId: encrypted.integrationId,
        credentialId: encrypted.credentialId,
        credentialVersion: encrypted.credentialVersion,
        source: encrypted.source,
      };
    }
    if (encrypted.status !== 'credential_absent') return encrypted;

    const integration = await this.dependencies.findIntegration(actor, selector.integrationId);
    if (!integration.success) return mapLookupFailure(integration);
    if (selector.credential === 'project-exact') {
      const token = integration.metadata.project_tokens?.[selector.projectId]?.token;
      const instanceUrl = normalizeGitLabInstanceUrl(
        integration.metadata.gitlab_instance_url ?? DEFAULT_GITLAB_INSTANCE_URL
      );
      if (!token || !instanceUrl) return { status: 'reconnect_required' };
      this.dependencies.reportFallback({
        integrationId: integration.integrationId,
        credential: selector.credential,
        status: 'resolved',
      });
      return {
        status: 'available',
        token,
        instanceUrl,
        glabIsOAuth2: false,
        integrationId: integration.integrationId,
        source: { type: 'project', projectId: selector.projectId },
      };
    }

    const legacy = await this.dependencies.getLegacyIntegrationToken(
      actor,
      integration.integrationId,
      integration.metadata
    );
    if (!legacy.success && legacy.reason === 'encrypted_credential_available') {
      const winner = await this.dependencies.getEncryptedCredential(actor, selector);
      if (winner.status !== 'available') {
        return winner.status === 'credential_absent'
          ? { status: 'temporarily_unavailable' }
          : winner;
      }
      return {
        status: 'available',
        token: winner.token,
        instanceUrl: winner.instanceUrl,
        glabIsOAuth2: winner.glabIsOAuth2,
        integrationId: winner.integrationId,
        credentialId: winner.credentialId,
        credentialVersion: winner.credentialVersion,
        source: winner.source,
      };
    }
    if (!legacy.success) return mapLegacyFailure(legacy);
    this.dependencies.reportFallback({
      integrationId: integration.integrationId,
      credential: selector.credential,
      status: 'resolved',
    });
    return {
      status: 'available',
      token: legacy.token,
      instanceUrl: legacy.instanceUrl,
      glabIsOAuth2:
        integration.integrationType === 'oauth' || integration.integrationType === 'pat'
          ? integration.integrationType === 'oauth'
          : integration.metadata.auth_type === 'oauth',
      integrationId: integration.integrationId,
      source: { type: 'integration' },
    };
  }
}
