import 'server-only';

import { z } from 'zod';
import type {
  OwnerIntegrationAuthorization,
  RepositoryIdentity,
} from '@kilocode/app-shared/code-review/repository-identity';
import type { ReviewActor, ReviewAuthorizationContext } from '@kilocode/app-shared/provider-review';
import { getGitLabIntegration } from '@/lib/integrations/gitlab-service';
import {
  createGitLabInteractiveClient,
  GitLabInteractiveError,
} from '@/lib/integrations/platforms/gitlab/interactive-client';
import {
  buildGitLabUrl,
  normalizeGitLabInstanceUrl,
} from '@/lib/integrations/platforms/gitlab/instance-url';
import type { GitLabCredentialSelector } from '@/lib/integrations/platforms/gitlab/credential-broker-client';

export function parseGitLab<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code: 'invalid_request' | 'invalid_response' = 'invalid_response'
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new GitLabInteractiveError(code);
  return parsed.data;
}

export const GitLabUserSchema = z.object({
  id: z.number().int().positive(),
  username: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
});
export function gitLabActor(
  value: z.infer<typeof GitLabUserSchema>,
  instanceUrl: string
): ReviewActor {
  return {
    provider: 'gitlab',
    instanceUrl,
    id: String(value.id),
    login: value.username ?? null,
    displayName: value.name ?? null,
    avatarUrl: z.url({ protocol: /^https$/ }).safeParse(value.avatar_url).success
      ? (value.avatar_url ?? null)
      : null,
  };
}

export const GitLabPathSchema = z
  .string()
  .min(1)
  .refine(
    value =>
      !value.includes('\0') && value.split('/').every(part => part && part !== '.' && part !== '..')
  );

function normalizeReviewInstance(value?: string): string {
  try {
    return normalizeGitLabInstanceUrl(value);
  } catch {
    throw new GitLabInteractiveError('unsafe_url');
  }
}
export const GitLabProjectSchema = z.object({
  id: z.number().int().positive(),
  path_with_namespace: GitLabPathSchema,
  web_url: z.url(),
  default_branch: z.string().nullable().optional(),
  merge_method: z.enum(['merge', 'rebase_merge', 'ff']).optional(),
  squash_option: z.enum(['never', 'always', 'default_on', 'default_off']).optional(),
  only_allow_merge_if_pipeline_succeeds: z.boolean().optional(),
  only_allow_merge_if_all_discussions_are_resolved: z.boolean().optional(),
  allow_merge_on_skipped_pipeline: z.boolean().optional(),
  permissions: z
    .object({
      project_access: z.object({ access_level: z.number() }).nullish(),
      group_access: z.object({ access_level: z.number() }).nullish(),
    })
    .optional(),
});

export function gitLabResourceUrl(instanceUrl: string, fullName: string, suffix = ''): string {
  const fullPath = parseGitLab(GitLabPathSchema, fullName);
  return buildGitLabUrl(
    instanceUrl,
    `/${fullPath.split('/').map(encodeURIComponent).join('/')}${suffix}`
  );
}

export async function authorizeGitLabReview(input: {
  userId: string;
  authorization: OwnerIntegrationAuthorization;
  instanceUrl: string;
  projectTokenId?: string;
}) {
  const authorization = parseGitLab(
    z.object({
      kind: z.literal('ownerIntegration'),
      integrationId: z.uuid(),
      owner: z.discriminatedUnion('type', [
        z.object({ type: z.literal('user'), id: z.string().min(1) }),
        z.object({ type: z.literal('org'), id: z.uuid() }),
      ]),
    }),
    input.authorization,
    'invalid_request'
  );
  if (
    !input.userId ||
    (authorization.owner.type === 'user' && authorization.owner.id !== input.userId)
  )
    throw new GitLabInteractiveError('forbidden');
  const integration = await getGitLabIntegration(authorization.owner, authorization.integrationId);
  if (
    !integration ||
    integration.platform !== 'gitlab' ||
    integration.id !== authorization.integrationId ||
    (authorization.owner.type === 'user'
      ? integration.owned_by_user_id !== input.userId ||
        integration.owned_by_organization_id !== null
      : integration.owned_by_organization_id !== authorization.owner.id ||
        integration.owned_by_user_id !== null)
  )
    throw new GitLabInteractiveError('not_connected');
  if (
    integration.integration_status !== 'active' ||
    integration.suspended_at ||
    integration.auth_invalid_at
  )
    throw new GitLabInteractiveError('reconnect_required');
  const metadata = parseGitLab(
    z.object({
      gitlab_instance_url: z.string().optional(),
      auth_type: z.enum(['oauth', 'pat']).optional(),
    }),
    integration.metadata ?? {}
  );
  // Old integrations omit the instance and auth_type. Keep the stored integration type and
  // default instance until old records/clients disappear and the 30-day ledger window expires.
  const instanceUrl = normalizeReviewInstance(metadata.gitlab_instance_url);
  if (normalizeReviewInstance(input.instanceUrl) !== instanceUrl)
    throw new GitLabInteractiveError('forbidden');
  const authType = parseGitLab(
    z.enum(['oauth', 'pat']),
    metadata.auth_type ?? integration.integration_type
  );
  const selector: GitLabCredentialSelector =
    input.projectTokenId === undefined
      ? { credential: 'integration', integrationId: integration.id }
      : {
          credential: 'project-exact',
          integrationId: integration.id,
          projectId: parseGitLab(
            z.string().regex(/^[1-9]\d*$/),
            input.projectTokenId,
            'invalid_request'
          ),
        };
  const credentialActor = {
    userId: input.userId,
    ...(authorization.owner.type === 'org' ? { organizationId: authorization.owner.id } : {}),
  };
  const client = (projectId?: string) =>
    createGitLabInteractiveClient({
      actor: credentialActor,
      selector,
      instanceUrl,
      scope: projectId === undefined ? { kind: 'discovery' } : { kind: 'project', projectId },
    });
  // The broker checks current membership, blocked users, exact ownership, and credential expiry.
  const current = await client(input.projectTokenId).execute(api => api.Users.showCurrentUser());
  const actor = gitLabActor(parseGitLab(GitLabUserSchema, current.data), instanceUrl);
  const credentialKind: ReviewAuthorizationContext['credentialKind'] =
    input.projectTokenId !== undefined
      ? 'gitlabProjectToken'
      : authType === 'pat'
        ? 'gitlabPat'
        : 'gitlabOAuth';
  return {
    userId: input.userId,
    authorization,
    instanceUrl,
    actor,
    credentialKind,
    client,
    projectTokenId: input.projectTokenId,
    // Integration scopes cannot describe a separate project token.
    scopes: input.projectTokenId === undefined ? integration.scopes : null,
  };
}
export type GitLabReviewAuthorization = Awaited<ReturnType<typeof authorizeGitLabReview>>;

export async function resolveGitLabReviewProject(
  auth: GitLabReviewAuthorization,
  projectId: string,
  expected?: RepositoryIdentity
) {
  parseGitLab(z.string().regex(/^[1-9]\d*$/), projectId, 'invalid_request');
  if (
    expected &&
    (expected.provider !== 'gitlab' ||
      expected.repositoryId !== projectId ||
      normalizeReviewInstance(expected.instanceUrl) !== auth.instanceUrl)
  )
    throw new GitLabInteractiveError('forbidden');
  const client = auth.client(projectId);
  const result = await client.execute(api => api.Projects.show(projectId));
  const project = parseGitLab(GitLabProjectSchema, result.data);
  const canonicalUrl = gitLabResourceUrl(auth.instanceUrl, project.path_with_namespace);
  if (
    String(project.id) !== projectId ||
    new URL(project.web_url).toString() !== canonicalUrl ||
    (expected && expected.fullName !== project.path_with_namespace)
  )
    throw new GitLabInteractiveError('not_found');
  const repository: RepositoryIdentity = {
    provider: 'gitlab',
    instanceUrl: auth.instanceUrl,
    repositoryId: projectId,
    fullName: project.path_with_namespace,
    defaultBranch: project.default_branch ?? null,
  };
  return { client, project, repository, canonicalUrl };
}
