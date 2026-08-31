import 'server-only';

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { CODE_REVIEW_PLATFORMS } from '@kilocode/app-shared/code-review';
import type {
  Owner,
  RepositoryIdentity,
} from '@kilocode/app-shared/code-review/repository-identity';
import {
  ReviewCursorSchema,
  ReviewIntentInputSchema,
  ReviewRevisionSchema,
  reviewResourceKey,
  serializeReviewWriteRequest,
  type ReviewIdentity,
  type ReviewIntent,
  type ReviewOverview,
} from '@kilocode/app-shared/provider-review';
import { baseProcedure, createTRPCRouter, type TRPCContext } from '@/lib/trpc/init';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { getAllIntegrationsForOwner } from '@/lib/integrations/db/platform-integrations';
import { normalizeGitLabInstanceUrl } from '@/lib/integrations/platforms/gitlab/instance-url';
import { GitLabInteractiveError } from '@/lib/integrations/platforms/gitlab/interactive-client';
import { BitbucketInteractiveClientError } from '@/lib/integrations/platforms/bitbucket/interactive-client';
import {
  authorizeGitLabReview,
  GitLabProjectSchema,
  gitLabResourceUrl,
  parseGitLab,
  type GitLabReviewAuthorization,
} from '@/lib/provider-review/gitlab-authorization';
import {
  authorizeBitbucketReview,
  BitbucketUuidSchema,
} from '@/lib/provider-review/bitbucket-authorization';
import {
  getGitLabReview,
  getGitLabChecks,
  listGitLabInbox,
  listGitLabFiles,
  getGitLabFileContext,
  listGitLabDiscussions,
} from '@/lib/provider-review/gitlab-read';
import {
  getBitbucketReview,
  getBitbucketChecks,
  listBitbucketInbox,
  listBitbucketFiles,
  getBitbucketFileContext,
  listBitbucketDiscussions,
} from '@/lib/provider-review/bitbucket-read';
import { runGitLabReviewOperation } from '@/lib/provider-review/gitlab-write';
import { runBitbucketReviewOperation } from '@/lib/provider-review/bitbucket-write';
import {
  createGitHubReviewBridge,
  GitHubReviewAddressSchema,
} from '@/lib/provider-review/github-bridge';

const id = z.string().min(1).max(4096);
const provider = z.enum(CODE_REVIEW_PLATFORMS);
const ownerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), id }),
  z.object({ type: z.literal('org'), id: z.uuid() }),
]);
const fullName = id.refine(
  value =>
    value.split('/').length >= 2 &&
    value
      .split('/')
      .every(
        part =>
          part &&
          part !== '.' &&
          part !== '..' &&
          !/[\\%?#]/.test(part) &&
          [...part].every(
            character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
          )
      )
);
// Old references omit provider, instance, integration and default branch. Resolve them
// through authorized lookup until old clients/records disappear and the 30-day ledger window expires.
const repositoryWire = z.object({
  provider: provider.default('github'),
  fullName,
  repositoryId: id.optional(),
  instanceUrl: z.url().optional(),
  defaultBranch: z.string().nullable().optional(),
  workspaceUuid: id.optional(),
});
const authorizationWire = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('githubUser'), accountId: id, authorizationId: id.optional() }),
  z.object({
    kind: z.literal('ownerIntegration'),
    owner: ownerSchema,
    integrationId: z.uuid().optional(),
  }),
]);
const number = z
  .union([z.string().regex(/^[1-9]\d*$/), z.number().int().positive().safe()])
  .transform(String);
const reviewWire = z.object({
  repository: repositoryWire,
  authorization: authorizationWire.optional(),
  number,
  reviewId: id.optional(),
  canonicalUrl: z.url().optional(),
});
// Old saved GitHub routes/drafts carry owner/repo/number and can contain unknown saved fields.
// Strip only those record additions until old clients/records and the 30-day ledger window expire.
const reviewInput = z.union([
  reviewWire,
  GitHubReviewAddressSchema.extend({
    accountId: id.optional(),
    provider: z.literal('github').optional(),
    instanceUrl: z.literal('https://github.com').optional(),
    repository: z.never().optional(),
    authorization: z.never().optional(),
  }).transform(value => ({
    repository: { provider: 'github' as const, fullName: `${value.owner}/${value.repo}` },
    authorization: value.accountId
      ? { kind: 'githubUser' as const, accountId: value.accountId }
      : undefined,
    number: String(value.number),
  })),
]);
const scopeInput = z.object({
  provider: provider.default('github'),
  owner: ownerSchema.optional(),
  integrationId: z.uuid().optional(),
  instanceUrl: z.url().optional(),
  repository: repositoryWire.optional(),
});
const pageInput = z.object({
  review: reviewInput,
  cursor: ReviewCursorSchema.nullish(),
  direction: z.enum(['forward', 'backward']).optional(),
});
const fileContextInput = z.object({
  file: z.object({
    oldPath: id.nullable(),
    newPath: id.nullable(),
    revision: ReviewRevisionSchema,
  }),
  side: z.enum(['old', 'new']),
  startLine: z.number().int().positive().safe(),
  lineCount: z.number().int().positive().max(500),
  versionId: id.optional(),
});
const operationInput = z.object({
  review: reviewInput,
  actorId: id,
  revision: ReviewRevisionSchema,
  input: ReviewIntentInputSchema,
  operationKey: z.uuid(),
});
type Scope = z.infer<typeof scopeInput>;
type ReviewWire = z.infer<typeof reviewWire>;
function fail(code: ConstructorParameters<typeof TRPCError>[0]['code'], message: string): never {
  throw new TRPCError({ code, message });
}

async function integrationFor(ctx: TRPCContext, input: Scope, url?: URL) {
  const owner: Owner = input.owner ?? { type: 'user', id: ctx.user.id };
  if (owner.type === 'user' && owner.id !== ctx.user.id) fail('FORBIDDEN', 'owner_mismatch');
  if (input.provider === 'bitbucket' && owner.type !== 'org')
    fail('FORBIDDEN', 'bitbucket_requires_organization');
  if (owner.type === 'org') await ensureOrganizationAccess(ctx, owner.id);
  const integrations = await getAllIntegrationsForOwner(owner);
  const candidates = integrations
    .filter(
      integration =>
        integration.platform === input.provider &&
        (!input.integrationId || input.integrationId === integration.id)
    )
    .map(integration => {
      // Old GitLab integration records omit the host. Retain its existing default until
      // old clients/records disappear and the 30-day ledger window expires.
      const metadata = z
        .object({ gitlab_instance_url: z.string().optional() })
        .parse(integration.metadata ?? {});
      return {
        integration,
        instanceUrl:
          input.provider === 'gitlab'
            ? normalizeGitLabInstanceUrl(metadata.gitlab_instance_url)
            : 'https://bitbucket.org',
      };
    })
    .filter(candidate => {
      if (input.instanceUrl && input.instanceUrl.replace(/\/+$/, '') !== candidate.instanceUrl)
        return false;
      if (!url) return true;
      const base = new URL(candidate.instanceUrl);
      return (
        url.origin === base.origin &&
        url.pathname.startsWith(`${base.pathname.replace(/\/+$/, '')}/`)
      );
    });
  if (!candidates.length) fail('NOT_FOUND', 'integration_not_found');
  if (candidates.length !== 1) fail('CONFLICT', 'integration_ambiguous');
  const selected = candidates[0];
  if (
    selected.integration.integration_status !== 'active' ||
    selected.integration.suspended_at ||
    selected.integration.auth_invalid_at
  )
    fail('PRECONDITION_FAILED', 'reconnect_required');
  return {
    ...selected,
    authorization: {
      kind: 'ownerIntegration' as const,
      owner,
      integrationId: selected.integration.id,
    },
  };
}
async function repositoryFor(
  input: z.infer<typeof repositoryWire>,
  selected: Awaited<ReturnType<typeof integrationFor>>,
  auth?: GitLabReviewAuthorization
): Promise<RepositoryIdentity> {
  if (
    input.provider !== selected.integration.platform ||
    (input.instanceUrl && input.instanceUrl.replace(/\/+$/, '') !== selected.instanceUrl)
  )
    fail('FORBIDDEN', 'repository_instance_mismatch');
  const matches =
    selected.integration.repositories?.filter(
      repository => repository.full_name === input.fullName
    ) ?? [];
  if (matches.length > 1) fail('CONFLICT', 'repository_ambiguous');
  let repositoryId = input.repositoryId ?? (matches[0] ? String(matches[0].id) : undefined);
  let defaultBranch = input.defaultBranch ?? matches[0]?.default_branch ?? null;
  if (!repositoryId && input.provider === 'gitlab' && auth) {
    // Discovery can omit accessible projects, including archived projects. Resolve only this path.
    const result = await auth
      .client(input.fullName)
      .execute(api => api.Projects.show(input.fullName));
    const project = parseGitLab(GitLabProjectSchema, result.data);
    if (
      project.path_with_namespace !== input.fullName ||
      new URL(project.web_url).toString() !== gitLabResourceUrl(auth.instanceUrl, input.fullName)
    )
      throw new GitLabInteractiveError('not_found');
    repositoryId = String(project.id);
    defaultBranch = project.default_branch ?? null;
  }
  if (!repositoryId) fail('NOT_FOUND', 'repository_selection_required');
  const common = {
    instanceUrl: selected.instanceUrl,
    repositoryId,
    fullName: input.fullName,
    defaultBranch,
  };
  return input.provider === 'bitbucket'
    ? {
        ...common,
        provider: 'bitbucket',
        repositoryId: BitbucketUuidSchema.parse(repositoryId),
        workspaceUuid: BitbucketUuidSchema.parse(
          input.workspaceUuid ?? selected.integration.platform_account_id
        ),
      }
    : { ...common, provider: 'gitlab' };
}
function assertResolved(input: ReviewWire, actual: ReviewIdentity, accountId: string) {
  const expected = input.repository;
  if (
    (input.reviewId && input.reviewId !== actual.reviewId) ||
    (input.canonicalUrl && input.canonicalUrl !== actual.canonicalUrl) ||
    (expected.repositoryId && expected.repositoryId !== actual.repository.repositoryId) ||
    (expected.workspaceUuid && expected.workspaceUuid !== actual.repository.workspaceUuid)
  )
    fail('CONFLICT', 'review_identity_changed');
  if (input.authorization?.kind === 'githubUser') {
    if (
      actual.authorization.kind !== 'githubUser' ||
      input.authorization.accountId !== accountId ||
      (input.authorization.authorizationId &&
        input.authorization.authorizationId !== actual.authorization.authorizationId)
    )
      fail('CONFLICT', 'review_authorization_changed');
  }
  reviewResourceKey(accountId, actual);
}
async function target(ctx: TRPCContext, input: ReviewWire) {
  if (input.repository.provider === 'github') {
    if (input.authorization?.kind === 'ownerIntegration')
      fail('FORBIDDEN', 'github_user_authorization_required');
    if (input.authorization && input.authorization.accountId !== ctx.user.id)
      fail('FORBIDDEN', 'account_mismatch');
    if (input.repository.instanceUrl && input.repository.instanceUrl !== 'https://github.com')
      fail('FORBIDDEN', 'repository_instance_mismatch');
    const bridge = createGitHubReviewBridge(ctx);
    const [owner, repo] = input.repository.fullName.split('/');
    if (input.repository.fullName.split('/').length !== 2)
      fail('BAD_REQUEST', 'invalid_repository_path');
    const expected = input.authorization?.authorizationId
      ? {
          kind: 'githubUser' as const,
          accountId: ctx.user.id,
          authorizationId: input.authorization.authorizationId,
        }
      : undefined;
    const overview = await bridge.getReview(
      { owner, repo, number: Number(input.number) },
      expected
    );
    assertResolved(input, overview.identity, ctx.user.id);
    return { provider: 'github' as const, bridge, overview };
  }
  if (input.authorization?.kind === 'githubUser') fail('FORBIDDEN', 'owner_integration_required');
  const selected = await integrationFor(ctx, {
    provider: input.repository.provider,
    owner: input.authorization?.owner,
    integrationId: input.authorization?.integrationId,
    instanceUrl: input.repository.instanceUrl,
  });
  if (input.repository.provider === 'gitlab') {
    const auth = await authorizeGitLabReview({
      userId: ctx.user.id,
      authorization: selected.authorization,
      instanceUrl: selected.instanceUrl,
    });
    const repository = await repositoryFor(input.repository, selected, auth);
    const overview = await getGitLabReview(auth, repository, input.number);
    assertResolved(input, overview.identity, ctx.user.id);
    return { provider: 'gitlab' as const, auth, overview };
  }
  const repository = await repositoryFor(input.repository, selected);
  const auth = await authorizeBitbucketReview({
    userId: ctx.user.id,
    authorization: selected.authorization,
    repository,
  });
  const overview = await getBitbucketReview(auth, input.number);
  assertResolved(input, overview.identity, ctx.user.id);
  return { provider: 'bitbucket' as const, auth, overview };
}

// Translate only sanitized adapter codes. GitHub TRPCErrors and their retry markers pass unchanged.
const procedure = baseProcedure.use(async ({ next }) => {
  const result = await next();
  if (result.ok) return result;
  const error = result.error.cause;
  if (
    !(error instanceof GitLabInteractiveError) &&
    !(error instanceof BitbucketInteractiveClientError)
  )
    return result;
  const code = error.code;
  const trpcCode = ['not_connected', 'reconnect_required', 'authentication_rejected'].includes(code)
    ? 'PRECONDITION_FAILED'
    : [
          'forbidden',
          'insufficient_permissions',
          'integration_mismatch',
          'workspace_mismatch',
          'repository_mismatch',
        ].includes(code)
      ? 'FORBIDDEN'
      : code === 'not_found'
        ? 'NOT_FOUND'
        : code === 'conflict'
          ? 'CONFLICT'
          : code === 'rate_limited'
            ? 'TOO_MANY_REQUESTS'
            : ['invalid_request', 'unsafe_url', 'invalid_pagination', 'request_too_large'].includes(
                  code
                )
              ? 'BAD_REQUEST'
              : 'SERVICE_UNAVAILABLE';
  throw new TRPCError({ code: trpcCode, message: code });
});
async function operation(
  ctx: TRPCContext,
  input: z.infer<typeof operationInput>,
  statusOnly: boolean
) {
  // No text truncation and no provider call precedes admission of the serialized request size.
  if (input.review.repository.provider !== 'github') {
    try {
      serializeReviewWriteRequest(input);
    } catch {
      fail('PAYLOAD_TOO_LARGE', 'request_too_large');
    }
  }
  const positions = [
    input.input.position,
    ...(input.input.comments?.map(comment => comment.position) ?? []),
  ];
  for (const position of positions) {
    if (!position) continue;
    if (position.native.provider !== input.review.repository.provider)
      fail('BAD_REQUEST', 'position_provider_mismatch');
    if (
      JSON.stringify(ReviewRevisionSchema.parse(position.revision)) !==
      JSON.stringify(ReviewRevisionSchema.parse(input.revision))
    )
      fail('CONFLICT', 'position_revision_mismatch');
  }
  const selected = await target(ctx, input.review);
  const { overview } = selected;
  if (input.actorId !== overview.authorization.actor.id) fail('CONFLICT', 'review_actor_changed');
  const intent: ReviewIntent = {
    accountId: ctx.user.id,
    review: overview.identity,
    actorId: input.actorId,
    revision: input.revision,
    input: input.input,
  };
  const request = {
    userId: ctx.user.id,
    distinctId: ctx.user.google_user_email ?? ctx.user.id,
    operationKey: input.operationKey,
    intent,
  };
  const result =
    selected.provider === 'github'
      ? await selected.bridge.runOperation(overview, intent, input.operationKey, statusOnly)
      : selected.provider === 'gitlab'
        ? await runGitLabReviewOperation(selected.auth, request, statusOnly)
        : await runBitbucketReviewOperation(
            selected.auth,
            {
              ...request,
              intent: {
                ...intent,
                revision: ReviewRevisionSchema.extend({
                  targetHeadSha: id,
                  startSha: z.null(),
                }).parse(intent.revision),
              },
            },
            statusOnly
          );
  return { result, authorization: overview.authorization };
}

export const providerReviewRouter = createTRPCRouter({
  getAuthorization: procedure.input(scopeInput).query(async ({ ctx, input }) => {
    if (input.provider === 'github') return createGitHubReviewBridge(ctx).getAuthorization();
    let selected: Awaited<ReturnType<typeof integrationFor>>;
    try {
      selected = await integrationFor(ctx, input);
    } catch (error) {
      if (error instanceof TRPCError && error.code === 'NOT_FOUND')
        return {
          status: 'not_connected' as const,
          reason: 'not_connected',
          authorization: null,
          actor: null,
        };
      throw error;
    }
    if (input.provider === 'gitlab') {
      const auth = await authorizeGitLabReview({
        userId: ctx.user.id,
        authorization: selected.authorization,
        instanceUrl: selected.instanceUrl,
      });
      return {
        status: 'connected' as const,
        reason: null,
        authorization: auth.authorization,
        actor: auth.actor,
      };
    }
    if (!input.repository)
      return {
        status: 'repository_required' as const,
        reason: 'select_repository',
        authorization: selected.authorization,
        actor: null,
      };
    const auth = await authorizeBitbucketReview({
      userId: ctx.user.id,
      authorization: selected.authorization,
      repository: await repositoryFor(input.repository, selected),
    });
    return {
      status: 'connected' as const,
      reason: null,
      authorization: auth.authorization,
      actor: auth.actor,
    };
  }),
  resolveUrl: procedure
    .input(
      z.object({
        url: z.url().max(8192),
        owner: ownerSchema.optional(),
        integrationId: z.uuid().optional(),
        accountId: id.optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      if (input.accountId && input.accountId !== ctx.user.id) fail('FORBIDDEN', 'account_mismatch');
      if (/\\|(?:\/|%2f)(?:\.|%2e){1,2}(?:\/|%2f)/i.test(input.url))
        fail('BAD_REQUEST', 'invalid_review_url');
      const url = new URL(input.url);
      if (url.username || url.password) fail('BAD_REQUEST', 'invalid_review_url');
      const platform = ['github.com', 'www.github.com'].includes(url.hostname)
        ? 'github'
        : url.hostname === 'bitbucket.org'
          ? 'bitbucket'
          : 'gitlab';
      if (url.protocol !== 'https:' && !(platform === 'github' && url.protocol === 'http:'))
        fail('BAD_REQUEST', 'invalid_review_url');
      if (platform === 'github') {
        if (url.port) fail('BAD_REQUEST', 'invalid_review_url');
        const match = url.pathname.match(
          /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)(?:\/(?:files|commits|checks))?\/?$/
        );
        if (!match) fail('BAD_REQUEST', 'invalid_review_path');
        return (
          await createGitHubReviewBridge(ctx).getReview({
            owner: match[1],
            repo: match[2],
            number: Number(match[3]),
          })
        ).identity;
      }
      const selected = await integrationFor(
        ctx,
        { provider: platform, owner: input.owner, integrationId: input.integrationId },
        url
      );
      const path = url.pathname.slice(
        new URL(selected.instanceUrl).pathname.replace(/\/+$/, '').length
      );
      const match = path.match(
        platform === 'gitlab'
          ? /^\/(.+)\/-\/merge_requests\/([1-9]\d*)(?:\/(?:diffs|commits|pipelines))?\/?$/
          : /^\/([^/]+\/[^/]+)\/pull-requests\/([1-9]\d*)(?:\/(?:diff|commits|activity))?\/?$/
      );
      if (!match) fail('BAD_REQUEST', 'invalid_review_path');
      let name: string;
      try {
        name = fullName.parse(decodeURIComponent(match[1]));
      } catch {
        fail('BAD_REQUEST', 'invalid_repository_path');
      }
      const resolved = await target(ctx, {
        repository: { provider: platform, instanceUrl: selected.instanceUrl, fullName: name },
        authorization: selected.authorization,
        number: match[2],
      });
      return resolved.overview.identity;
    }),
  getReview: procedure
    .input(z.object({ review: reviewInput }))
    .query(async ({ ctx, input }) => (await target(ctx, input.review)).overview),
  listInbox: procedure
    .input(
      scopeInput.extend({
        cursor: ReviewCursorSchema.nullish(),
        direction: z.enum(['forward', 'backward']).optional(),
        filter: z.enum(['reviewer', 'author']).optional(),
        state: z.enum(['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      if (input.provider === 'github') return createGitHubReviewBridge(ctx).listInbox(input.cursor);
      const selected = await integrationFor(ctx, input);
      if (input.provider === 'gitlab') {
        const auth = await authorizeGitLabReview({
          userId: ctx.user.id,
          authorization: selected.authorization,
          instanceUrl: selected.instanceUrl,
        });
        const repository = input.repository
          ? await repositoryFor(input.repository, selected, auth)
          : undefined;
        return listGitLabInbox(auth, { repository, filter: input.filter, cursor: input.cursor });
      }
      if (!input.repository) fail('BAD_REQUEST', 'repository_selection_required');
      const repository = await repositoryFor(input.repository, selected);
      const auth = await authorizeBitbucketReview({
        userId: ctx.user.id,
        authorization: selected.authorization,
        repository,
      });
      return listBitbucketInbox(auth, { cursor: input.cursor, state: input.state });
    }),
  listFiles: procedure
    .input(pageInput.extend({ revision: ReviewRevisionSchema, versionId: id.optional() }))
    .query(async ({ ctx, input }) => {
      const selected = await target(ctx, input.review);
      const { overview } = selected;
      if (
        selected.provider === 'github' &&
        JSON.stringify(input.revision) !== JSON.stringify(overview.revision)
      )
        fail('CONFLICT', 'review_revision_changed');
      if (selected.provider !== 'gitlab' && input.versionId)
        fail('BAD_REQUEST', 'diff_version_not_available');
      const result =
        selected.provider === 'github'
          ? await selected.bridge.listFiles(overview, input.cursor)
          : selected.provider === 'gitlab'
            ? await listGitLabFiles(
                selected.auth,
                overview.identity,
                input.revision,
                input.cursor,
                input.versionId
              )
            : await listBitbucketFiles(
                selected.auth,
                overview.identity,
                input.revision,
                input.cursor
              );
      return { ...result, authorization: overview.authorization };
    }),
  getFileContext: procedure
    .input(z.object({ review: reviewInput, context: fileContextInput }))
    .query(async ({ ctx, input }) => {
      const selected = await target(ctx, input.review);
      const { overview } = selected;
      if (selected.provider !== 'gitlab' && input.context.versionId)
        fail('BAD_REQUEST', 'diff_version_not_available');
      const result =
        selected.provider === 'github'
          ? await selected.bridge.getFileContext(overview, input.context)
          : selected.provider === 'gitlab'
            ? await getGitLabFileContext(selected.auth, overview.identity, input.context)
            : await getBitbucketFileContext(selected.auth, overview.identity, input.context);
      return { ...result, authorization: overview.authorization };
    }),
  listChecks: procedure
    .input(z.object({ review: reviewInput, revision: ReviewRevisionSchema }))
    .query(async ({ ctx, input }) => {
      const selected = await target(ctx, input.review);
      const { overview } = selected;
      if (
        selected.provider === 'github' &&
        JSON.stringify(input.revision) !== JSON.stringify(overview.revision)
      )
        fail('CONFLICT', 'review_revision_changed');
      const checks: ReviewOverview['checks'] =
        selected.provider === 'github'
          ? overview.checks
          : selected.provider === 'gitlab'
            ? await getGitLabChecks(selected.auth, overview.identity, input.revision)
            : await getBitbucketChecks(selected.auth, overview.identity, input.revision);
      return { checks, authorization: overview.authorization };
    }),
  listDiscussions: procedure.input(pageInput).query(async ({ ctx, input }) => {
    const selected = await target(ctx, input.review);
    const { overview } = selected;
    const result =
      selected.provider === 'github'
        ? await selected.bridge.listDiscussions(overview, input.cursor)
        : selected.provider === 'gitlab'
          ? await listGitLabDiscussions(selected.auth, overview.identity, input.cursor)
          : await listBitbucketDiscussions(selected.auth, overview.identity, input.cursor);
    return { ...result, authorization: overview.authorization };
  }),
  act: procedure.input(operationInput).mutation(({ ctx, input }) => operation(ctx, input, false)),
  getOperationStatus: procedure
    .input(operationInput)
    .query(({ ctx, input }) => operation(ctx, input, true)),
});
