import { z } from 'zod';
import { GitLabCredentialBroker } from './gitlab-credential-broker.js';
import { GitLabCredentialCrypto } from './gitlab-credential-crypto.js';
import {
  GitLabCredentialService,
  type GitLabCredentialActor,
} from './gitlab-credential-service.js';
import { DrizzleGitLabCredentialStore } from './gitlab-credential-store.js';
import { GitLabLookupService } from './gitlab-lookup-service.js';
import { GitLabOAuthCredentialRefresher } from './gitlab-oauth-credential-refresher.js';
import { GitLabTokenService } from './gitlab-token-service.js';

export const GitLabCredentialBrokerRequestSchema = z.discriminatedUnion('credential', [
  z
    .object({
      credential: z.literal('integration'),
      integrationId: z.uuid(),
    })
    .strict(),
  z
    .object({
      credential: z.literal('project-exact'),
      integrationId: z.uuid(),
      projectId: z.string().regex(/^[1-9][0-9]*$/),
    })
    .strict(),
]);

export type GitLabCredentialBrokerRequest = z.infer<typeof GitLabCredentialBrokerRequestSchema>;

export function createGitLabCredentialService(env: CloudflareEnv): GitLabCredentialService {
  const crypto = new GitLabCredentialCrypto(env);
  const refresher = new GitLabOAuthCredentialRefresher(env, { crypto });
  return new GitLabCredentialService(new DrizzleGitLabCredentialStore(env), crypto, refresher);
}

export function createGitLabCredentialBroker(env: CloudflareEnv): GitLabCredentialBroker {
  const lookupService = new GitLabLookupService(env);
  const tokenService = new GitLabTokenService(env, new GitLabOAuthCredentialRefresher(env));
  const credentialService = createGitLabCredentialService(env);
  return new GitLabCredentialBroker({
    findIntegration: (actor, integrationId) =>
      lookupService.findGitLabIntegration(actor, integrationId),
    getLegacyIntegrationToken: (actor, integrationId, metadata) =>
      tokenService.getToken(integrationId, metadata, actor),
    getEncryptedCredential: (actor, selector) => credentialService.getCredential(actor, selector),
    hasProjectCredentialCandidates: (actor, integrationId) =>
      credentialService.hasProjectCredentialCandidates(actor, integrationId),
    reportFallback: event => {
      console.warn(JSON.stringify({ message: 'GitLab legacy credential fallback', ...event }));
    },
  });
}

export async function handleGitLabCredentialBrokerRequest(
  env: CloudflareEnv,
  actor: GitLabCredentialActor,
  selector: GitLabCredentialBrokerRequest
) {
  const result = await createGitLabCredentialBroker(env).resolveCredential(actor, selector);
  if (result.status !== 'available') return result;
  return {
    status: 'available',
    token: result.token,
    instanceUrl: result.instanceUrl,
    glabIsOAuth2: result.glabIsOAuth2,
  } as const;
}
