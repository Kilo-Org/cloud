import 'server-only';

import { z } from 'zod';
import {
  repositoryResourceKey,
  type OwnerIntegrationAuthorization,
  type RepositoryIdentity,
} from '@kilocode/app-shared/code-review/repository-identity';
import type { ReviewActor, ReviewIdentity } from '@kilocode/app-shared/provider-review';
import {
  BitbucketInteractiveClientError,
  createBitbucketInteractiveClient,
  type BitbucketInteractiveBrokerRequest,
  type BitbucketInteractiveMetadata,
} from '@/lib/integrations/platforms/bitbucket/interactive-client';
import {
  normalizeBitbucketUuid,
  parseBitbucketCloneUrl,
} from '../../../../../services/git-token-service/src/bitbucket-url';

export function parseBitbucket<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code: BitbucketInteractiveClientError['code'] = 'invalid_response'
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BitbucketInteractiveClientError(code);
  return parsed.data;
}

export const BitbucketUuidSchema = z.string().transform(normalizeBitbucketUuid).pipe(z.string());
const canonicalUuid = z.string().refine(value => normalizeBitbucketUuid(value) === value);
const fullName = z
  .string()
  .max(511)
  .refine(value => {
    const parsed = parseBitbucketCloneUrl(`https://bitbucket.org/${value}.git`);
    return parsed.success && parsed.fullName === value;
  });
export const BitbucketPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    value =>
      !value.includes('\\') &&
      [...value].every(
        character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
      ) &&
      value.split('/').every(part => part && part !== '.' && part !== '..')
  );
export const BitbucketRepositoryIdentitySchema = z.object({
  provider: z.literal('bitbucket'),
  instanceUrl: z.literal('https://bitbucket.org'),
  repositoryId: canonicalUuid,
  workspaceUuid: canonicalUuid,
  fullName,
  defaultBranch: z.string().min(1).nullable(),
});
export const BitbucketProviderRepositorySchema = z
  .object({
    uuid: BitbucketUuidSchema,
    full_name: fullName,
    workspace: z.object({ uuid: BitbucketUuidSchema, slug: z.string().min(1) }),
    mainbranch: z.object({ name: z.string().min(1) }).nullish(),
  })
  .refine(value => value.full_name.split('/')[0] === value.workspace.slug);
export const BitbucketUserSchema = z.object({
  uuid: BitbucketUuidSchema,
  nickname: z.string().nullish(),
  display_name: z.string().nullish(),
  links: z.object({ avatar: z.object({ href: z.string() }).optional() }).optional(),
});
export function bitbucketActor(user: z.infer<typeof BitbucketUserSchema>): ReviewActor {
  const avatar = user.links?.avatar?.href;
  return {
    provider: 'bitbucket',
    instanceUrl: 'https://bitbucket.org',
    id: user.uuid,
    displayName: user.display_name ?? null,
    login: user.nickname ?? null,
    avatarUrl: avatar && z.url({ protocol: /^https$/ }).safeParse(avatar).success ? avatar : null,
  };
}
export function bitbucketRepository(value: z.infer<typeof BitbucketProviderRepositorySchema>) {
  return {
    provider: 'bitbucket' as const,
    instanceUrl: 'https://bitbucket.org',
    workspaceUuid: value.workspace.uuid,
    repositoryId: value.uuid,
    fullName: value.full_name,
    defaultBranch: value.mainbranch?.name ?? null,
  };
}

export function assertBitbucketRepository(expected: RepositoryIdentity, value: unknown) {
  const repository = bitbucketRepository(parseBitbucket(BitbucketProviderRepositorySchema, value));
  if (expected.provider !== 'bitbucket' || repository.workspaceUuid !== expected.workspaceUuid)
    throw new BitbucketInteractiveClientError('workspace_mismatch');
  if (
    repository.repositoryId !== expected.repositoryId ||
    repository.fullName !== expected.fullName ||
    repository.instanceUrl !== expected.instanceUrl
  )
    throw new BitbucketInteractiveClientError('repository_mismatch');
  return repository;
}

function principal(metadata: BitbucketInteractiveMetadata): ReviewActor {
  const value = metadata.providerActor;
  if (value.credentialKind === 'bitbucketOAuth')
    return { ...value.actor, id: normalizeBitbucketUuid(value.actor.id) ?? value.actor.id };
  return {
    provider: 'bitbucket',
    instanceUrl: metadata.instanceUrl,
    // Workspace principals must not collide with a provider user's UUID or impersonate the Kilo caller.
    id: `workspace:${parseBitbucket(BitbucketUuidSchema, value.workspaceUuid)}`,
    displayName: value.workspaceSlug,
    login: null,
    avatarUrl: null,
  };
}

export async function authorizeBitbucketReview(input: {
  userId: string;
  authorization: OwnerIntegrationAuthorization;
  repository: RepositoryIdentity;
}) {
  const userId = parseBitbucket(z.string().min(1), input.userId, 'invalid_request');
  const authorization = parseBitbucket(
    z.object({
      kind: z.literal('ownerIntegration'),
      owner: z.object({ type: z.literal('org'), id: z.uuid() }),
      integrationId: z.uuid(),
    }),
    input.authorization,
    'invalid_request'
  );
  const expected = parseBitbucket(
    BitbucketRepositoryIdentitySchema,
    input.repository,
    'invalid_request'
  );
  const workspaceSlug = expected.fullName.split('/')[0];
  const broker = createBitbucketInteractiveClient({
    actorUserId: userId,
    organizationId: authorization.owner.id,
    workspace: {
      integrationId: authorization.integrationId,
      workspaceUuid: expected.workspaceUuid,
      workspaceSlug,
    },
    repository: { repositoryUuid: expected.repositoryId, repositoryFullName: expected.fullName },
  });
  // The broker rechecks membership, blocked users, integration, cache identity and credential generation on every call.
  let credentialIdentity: string | undefined;
  const client = {
    async execute<K extends BitbucketInteractiveBrokerRequest['operation']>(
      request: BitbucketInteractiveBrokerRequest<K>
    ) {
      const result = await broker.execute<K>(request);
      const metadata = result.metadata;
      if (
        metadata.actorUserId !== userId ||
        metadata.organizationId !== authorization.owner.id ||
        metadata.integrationId !== authorization.integrationId ||
        metadata.instanceUrl !== expected.instanceUrl
      )
        throw new BitbucketInteractiveClientError('integration_mismatch');
      const providerActor = metadata.providerActor;
      if (
        providerActor.credentialKind === 'bitbucketWorkspaceToken' &&
        (normalizeBitbucketUuid(providerActor.workspaceUuid) !== expected.workspaceUuid ||
          providerActor.workspaceSlug !== workspaceSlug)
      )
        throw new BitbucketInteractiveClientError('workspace_mismatch');
      const current = JSON.stringify([
        providerActor.credentialKind,
        principal(metadata).id,
        [...new Set(metadata.grants.scopes)].sort(),
      ]);
      if (credentialIdentity !== undefined && credentialIdentity !== current)
        throw new BitbucketInteractiveClientError('reconnect_required');
      credentialIdentity = current;
      return result;
    },
  };
  const path = {
    workspace: `{${expected.workspaceUuid}}`,
    repo_slug: `{${expected.repositoryId}}`,
  };
  const result = await client.execute({ operation: 'repository', params: { path } });
  if (result.status !== 200) throw new BitbucketInteractiveClientError('invalid_response');
  const repository = assertBitbucketRepository(expected, result.data);
  return {
    userId,
    authorization,
    repository,
    path,
    client,
    actor: principal(result.metadata),
    credentialKind: result.metadata.providerActor.credentialKind,
    scopes: result.metadata.grants.scopes,
  };
}
export type BitbucketReviewAuthorization = Awaited<ReturnType<typeof authorizeBitbucketReview>>;

export function assertBitbucketReviewIdentity(
  auth: BitbucketReviewAuthorization,
  identity: ReviewIdentity
) {
  const repository = parseBitbucket(
    BitbucketRepositoryIdentitySchema,
    identity.repository,
    'invalid_request'
  );
  const authorization = parseBitbucket(
    z.object({
      kind: z.literal('ownerIntegration'),
      owner: z.object({ type: z.literal('org'), id: z.uuid() }),
      integrationId: z.uuid(),
    }),
    identity.authorization,
    'invalid_request'
  );
  if (
    repositoryResourceKey(auth.userId, { repository, authorization }) !==
    repositoryResourceKey(auth.userId, auth)
  )
    throw new BitbucketInteractiveClientError('repository_mismatch');
  const number = parseBitbucket(z.string().regex(/^[1-9]\d*$/), identity.number, 'invalid_request');
  if (
    identity.reviewId !== number ||
    identity.canonicalUrl !==
      `https://bitbucket.org/${auth.repository.fullName}/pull-requests/${number}`
  )
    throw new BitbucketInteractiveClientError('repository_mismatch');
}
