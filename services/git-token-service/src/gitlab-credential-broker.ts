import type {
  GitLabCredentialActor,
  GitLabCredentialResult,
  GitLabCredentialSelector,
} from './gitlab-credential-service.js';

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
  getEncryptedCredential(
    actor: GitLabCredentialActor,
    selector: GitLabCredentialSelector
  ): Promise<GitLabCredentialResult>;
  hasProjectCredentialCandidates(
    actor: GitLabCredentialActor,
    integrationId: string
  ): Promise<boolean>;
};

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

    // No encrypted credential row exists for this selector. All GitLab
    // credentials have been backfilled to encrypted storage, so this means
    // there is genuinely no credential to resolve (e.g. no project-specific
    // token has been created, or the integration needs to be reconnected).
    return selector.credential === 'project-exact'
      ? { status: 'not_connected' }
      : { status: 'reconnect_required' };
  }
}
