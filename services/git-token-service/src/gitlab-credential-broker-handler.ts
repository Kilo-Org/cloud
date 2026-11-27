import { z } from 'zod';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import { GitLabCredentialBroker } from './gitlab-credential-broker.js';
import { GitLabCredentialCrypto } from './gitlab-credential-crypto.js';
import {
  GitLabCredentialService,
  type GitLabCredentialActor,
} from './gitlab-credential-service.js';
import { DrizzleGitLabCredentialStore } from './gitlab-credential-store.js';
import { GitLabOAuthCredentialRefresher } from './gitlab-oauth-credential-refresher.js';

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

export function createGitLabCredentialService(
  env: CloudflareEnv,
  ctx?: SecretsExecutionContext
): GitLabCredentialService {
  const crypto = new GitLabCredentialCrypto(env, ctx);
  const refresher = new GitLabOAuthCredentialRefresher(env, { crypto }, ctx);
  return new GitLabCredentialService(new DrizzleGitLabCredentialStore(env), crypto, refresher);
}

export function createGitLabCredentialBroker(
  env: CloudflareEnv,
  ctx?: SecretsExecutionContext
): GitLabCredentialBroker {
  const credentialService = createGitLabCredentialService(env, ctx);
  return new GitLabCredentialBroker({
    getEncryptedCredential: (actor, selector) => credentialService.getCredential(actor, selector),
    hasProjectCredentialCandidates: (actor, integrationId) =>
      credentialService.hasProjectCredentialCandidates(actor, integrationId),
  });
}

export async function handleGitLabCredentialBrokerRequest(
  env: CloudflareEnv,
  actor: GitLabCredentialActor,
  selector: GitLabCredentialBrokerRequest,
  ctx?: SecretsExecutionContext
) {
  const result = await createGitLabCredentialBroker(env, ctx).resolveCredential(actor, selector);
  if (result.status !== 'available') return result;
  return {
    status: 'available',
    token: result.token,
    instanceUrl: result.instanceUrl,
    glabIsOAuth2: result.glabIsOAuth2,
  } as const;
}
