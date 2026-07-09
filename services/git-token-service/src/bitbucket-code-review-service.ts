import { hasRequiredBitbucketWorkspaceAccessTokenScopes } from '@kilocode/worker-utils';
import { z } from 'zod';
import {
  BitbucketWorkspaceAccessTokenAuthorizationService,
  type BitbucketWorkspaceAccessTokenAuthorization,
  type BitbucketWorkspaceAccessTokenAuthorizationResult,
} from './bitbucket-workspace-access-token-authorization-service.js';
import { normalizeBitbucketUuid } from './bitbucket-url.js';

const BITBUCKET_API_ORIGIN = 'https://api.bitbucket.org';
const BITBUCKET_API_PREFIX = `${BITBUCKET_API_ORIGIN}/2.0`;
const BITBUCKET_MAX_JSON_RESPONSE_BYTES = 256_000;
const BITBUCKET_MAX_WRITE_BODY_BYTES = 16_000;
const BITBUCKET_REQUEST_TIMEOUT_MS = 30_000;
const BITBUCKET_WEBHOOK_PAGE_LENGTH = 50;
const BITBUCKET_MAX_WEBHOOK_PAGES = 10;
const BITBUCKET_MAX_WEBHOOK_ITEMS = 200;

export const BITBUCKET_CODE_REVIEW_WEBHOOK_EVENTS = [
  'pullrequest:created',
  'pullrequest:updated',
  'pullrequest:fulfilled',
  'pullrequest:rejected',
] as const;

const CanonicalBitbucketUuidSchema = z
  .string()
  .uuid()
  .refine(value => normalizeBitbucketUuid(value) === value);
const BitbucketPathSegmentSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/)
  .refine(value => value !== '.' && value !== '..');
const BitbucketRepositoryFullNameSchema = z
  .string()
  .min(3)
  .max(511)
  .superRefine((value, context) => {
    const segments = value.split('/');
    if (
      segments.length !== 2 ||
      segments.some(segment => !BitbucketPathSegmentSchema.safeParse(segment).success)
    ) {
      context.addIssue({ code: 'custom', message: 'Invalid Bitbucket repository path' });
    }
  });

const BitbucketCodeReviewOwnerSchema = z
  .object({
    userId: z.string().min(1).max(255),
    orgId: z.string().uuid(),
  })
  .strict();

export const BitbucketWorkspaceTargetSchema = z
  .object({
    owner: BitbucketCodeReviewOwnerSchema,
    integrationId: z.string().uuid(),
    workspaceUuid: CanonicalBitbucketUuidSchema,
    workspaceSlug: BitbucketPathSegmentSchema,
  })
  .strict();

export const BitbucketPullRequestRequestSchema = BitbucketWorkspaceTargetSchema.extend({
  repositoryUuid: CanonicalBitbucketUuidSchema,
  repositoryFullName: BitbucketRepositoryFullNameSchema,
  pullRequestId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

const BitbucketWebhookCallbackUrlSchema = z
  .string()
  .url()
  .max(2048)
  .superRefine((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'Invalid Bitbucket callback URL' });
      return;
    }
    const pathSegments = url.pathname.split('/').filter(Boolean);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.href !== value ||
      pathSegments.length !== 4 ||
      pathSegments[0] !== 'api' ||
      pathSegments[1] !== 'webhooks' ||
      pathSegments[2] !== 'bitbucket' ||
      !z.string().uuid().safeParse(pathSegments[3]).success ||
      url.pathname !== `/api/webhooks/bitbucket/${pathSegments[3]}`
    ) {
      context.addIssue({ code: 'custom', message: 'Invalid Bitbucket callback URL' });
    }
  });

export const BitbucketEnsureWebhookRequestSchema = BitbucketWorkspaceTargetSchema.extend({
  callbackUrl: BitbucketWebhookCallbackUrlSchema,
  secret: z
    .string()
    .min(32)
    .max(128)
    .regex(/^[\x21-\x7e]+$/),
}).strict();

export const BitbucketDeleteWebhookRequestSchema = BitbucketWorkspaceTargetSchema.extend({
  callbackUrl: BitbucketWebhookCallbackUrlSchema,
}).strict();

const BitbucketProviderCommitHashSchema = z.string().regex(/^[0-9a-fA-F]{7,40}$/);
const BitbucketFullCommitHashSchema = z.string().regex(/^[0-9a-fA-F]{40}$/);

const BitbucketPullRequestRepositoryPayloadSchema = z.object({
  uuid: z.string().min(1).max(128),
  full_name: z.string().min(3).max(511),
  workspace: z
    .object({
      uuid: z.string().min(1).max(128),
      slug: z.string().min(1).max(255),
    })
    .optional(),
});

const BitbucketPullRequestSidePayloadSchema = z.object({
  repository: BitbucketPullRequestRepositoryPayloadSchema,
  branch: z.object({ name: z.string().min(1).max(1024) }),
  commit: z.object({ hash: BitbucketProviderCommitHashSchema }),
});

const BitbucketPullRequestPayloadSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1).max(1024),
  state: z.enum(['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']),
  draft: z.boolean(),
  updated_on: z.string().min(1).max(100),
  author: z.object({
    uuid: z.string().min(1).max(128),
    display_name: z.string().min(1).max(255),
  }),
  source: BitbucketPullRequestSidePayloadSchema,
  destination: BitbucketPullRequestSidePayloadSchema,
  links: z.object({ html: z.object({ href: z.string().url().max(2048) }) }),
});

const BitbucketCommitPayloadSchema = z.object({
  hash: BitbucketFullCommitHashSchema,
});

const BitbucketWebhookPayloadSchema = z.object({
  uuid: z.string().min(1).max(128),
  url: z.string().url().max(2048),
  active: z.boolean(),
  events: z
    .array(
      z
        .string()
        .min(1)
        .max(100)
        .regex(/^[a-z]+:[a-z_]+$/)
    )
    .max(64),
  secret_set: z.boolean(),
});

const BitbucketWebhookPageSchema = z
  .object({
    pagelen: z.number().int().positive().max(BITBUCKET_WEBHOOK_PAGE_LENGTH),
    values: z.array(BitbucketWebhookPayloadSchema).max(BITBUCKET_WEBHOOK_PAGE_LENGTH),
    next: z.string().min(1).max(4096).optional(),
  })
  .refine(page => page.values.length <= page.pagelen);

export type BitbucketWorkspaceTarget = z.infer<typeof BitbucketWorkspaceTargetSchema>;
export type BitbucketPullRequestRequest = z.infer<typeof BitbucketPullRequestRequestSchema>;
export type BitbucketEnsureWebhookRequest = z.infer<typeof BitbucketEnsureWebhookRequestSchema>;
export type BitbucketDeleteWebhookRequest = z.infer<typeof BitbucketDeleteWebhookRequestSchema>;

export type BitbucketPullRequestProjection = {
  id: number;
  state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';
  draft: boolean;
  updatedOn: string;
  title: string;
  author: {
    uuid: string;
    displayName: string;
  };
  source: BitbucketPullRequestSideProjection;
  destination: BitbucketPullRequestSideProjection;
  url: string;
};

type BitbucketPullRequestSideProjection = {
  repositoryUuid: string;
  repositoryFullName: string;
  branch: string;
  sha: string;
};

export type BitbucketCodeReviewFailureReason =
  | 'invalid_request'
  | 'not_connected'
  | 'reconnect_required'
  | 'temporarily_unavailable'
  | 'insufficient_permissions'
  | 'integration_mismatch'
  | 'workspace_mismatch'
  | 'repository_mismatch'
  | 'pull_request_not_found';

export type BitbucketPullRequestResult =
  | { success: true; pullRequest: BitbucketPullRequestProjection }
  | { success: false; reason: BitbucketCodeReviewFailureReason };

export type BitbucketWorkspaceWebhook = {
  uuid: string;
  callbackUrl: string;
  active: boolean;
  events: string[];
  secretSet: boolean;
};

export type BitbucketWorkspaceWebhookListResult =
  | { success: true; webhooks: BitbucketWorkspaceWebhook[] }
  | { success: false; reason: BitbucketCodeReviewFailureReason };

export type BitbucketEnsureWebhookResult =
  | { success: true; webhook: BitbucketWorkspaceWebhook }
  | { success: false; reason: BitbucketCodeReviewFailureReason };

export type BitbucketDeleteWebhookResult =
  | { success: true }
  | { success: false; reason: BitbucketCodeReviewFailureReason };

type AuthorizationService = Pick<
  BitbucketWorkspaceAccessTokenAuthorizationService,
  'getAuthorization' | 'invalidateAuthorization'
>;

type BitbucketCodeReviewServiceOptions = {
  fetch?: typeof fetch;
  authorizationService?: AuthorizationService;
};

type AuthorizedWorkspace = {
  authorization: BitbucketWorkspaceAccessTokenAuthorization;
  hooksEndpoint: string;
};

type ProviderErrorCode =
  | 'authentication_rejected'
  | 'insufficient_permissions'
  | 'invalid_response'
  | 'not_found'
  | 'redirect_rejected'
  | 'request_failed'
  | 'response_too_large';

function defaultFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
  return globalThis.fetch(input, init);
}

class BitbucketCodeReviewProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    readonly status?: number,
    readonly context?: Record<string, unknown>
  ) {
    super(code);
    this.name = 'BitbucketCodeReviewProviderError';
  }
}

function hasNonVisibleAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return true;
  }
  return false;
}

function hasExactWebhookEvents(events: readonly string[]): boolean {
  return (
    events.length === BITBUCKET_CODE_REVIEW_WEBHOOK_EVENTS.length &&
    BITBUCKET_CODE_REVIEW_WEBHOOK_EVENTS.every(event => events.includes(event))
  );
}

function callbackMatchesIntegration(callbackUrl: string, integrationId: string): boolean {
  return new URL(callbackUrl).pathname === `/api/webhooks/bitbucket/${integrationId}`;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new BitbucketCodeReviewProviderError('invalid_response');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) {
        throw new BitbucketCodeReviewProviderError('invalid_response');
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The bounded read remains failed if cancellation also fails.
        }
        throw new BitbucketCodeReviewProviderError('response_too_large');
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof BitbucketCodeReviewProviderError) throw error;
    throw new BitbucketCodeReviewProviderError('invalid_response');
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    throw new BitbucketCodeReviewProviderError('invalid_response');
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    return;
  }
}

function normalizePullRequestSide(
  side: z.infer<typeof BitbucketPullRequestSidePayloadSchema>,
  target: z.infer<typeof BitbucketPullRequestRequestSchema>
): BitbucketPullRequestSideProjection | null {
  const repositoryUuid = normalizeBitbucketUuid(side.repository.uuid);
  const repositoryWorkspaceUuid = side.repository.workspace
    ? normalizeBitbucketUuid(side.repository.workspace.uuid)
    : target.workspaceUuid;
  if (
    repositoryUuid !== target.repositoryUuid ||
    repositoryWorkspaceUuid !== target.workspaceUuid ||
    (side.repository.workspace && side.repository.workspace.slug !== target.workspaceSlug) ||
    side.repository.full_name !== target.repositoryFullName
  ) {
    return null;
  }
  return {
    repositoryUuid,
    repositoryFullName: side.repository.full_name,
    branch: side.branch.name,
    sha: side.commit.hash.toLowerCase(),
  };
}

function normalizeWebhookPayload(
  webhook: z.infer<typeof BitbucketWebhookPayloadSchema>
): BitbucketWorkspaceWebhook | null {
  const uuid = normalizeBitbucketUuid(webhook.uuid);
  if (!uuid || new Set(webhook.events).size !== webhook.events.length) return null;
  return {
    uuid,
    callbackUrl: webhook.url,
    active: webhook.active,
    events: [...webhook.events].sort(),
    secretSet: webhook.secret_set,
  };
}

function validateWebhookNextLink(value: string, hooksEndpoint: string): string {
  if (!value.startsWith(`${hooksEndpoint}?`) || hasNonVisibleAscii(value)) {
    throw new BitbucketCodeReviewProviderError('invalid_response');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
    decodeURIComponent(`${parsed.pathname}${parsed.search}`);
  } catch {
    throw new BitbucketCodeReviewProviderError('invalid_response');
  }
  const pageLengths = parsed.searchParams.getAll('pagelen');
  const hasCaseVariantPageLength = [...parsed.searchParams.keys()].some(
    name => name !== 'pagelen' && name.toLowerCase() === 'pagelen'
  );
  if (
    parsed.origin !== BITBUCKET_API_ORIGIN ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.hash !== '' ||
    parsed.pathname !== new URL(hooksEndpoint).pathname ||
    parsed.href !== value ||
    hasCaseVariantPageLength ||
    pageLengths.length > 1 ||
    (pageLengths.length === 1 &&
      (!/^[1-9][0-9]*$/.test(pageLengths[0]) ||
        Number(pageLengths[0]) > BITBUCKET_WEBHOOK_PAGE_LENGTH))
  ) {
    throw new BitbucketCodeReviewProviderError('invalid_response');
  }
  return value;
}

function mapAuthorizationFailure(
  authorization: Exclude<BitbucketWorkspaceAccessTokenAuthorizationResult, { status: 'available' }>
): { success: false; reason: BitbucketCodeReviewFailureReason } {
  console.warn('[bitbucket-code-review] Authorization failure', {
    authorizationStatus: authorization.status,
  });
  return { success: false, reason: authorization.status };
}

export class BitbucketCodeReviewService {
  private readonly fetchImplementation: typeof fetch;
  private readonly authorizationService: AuthorizationService;

  constructor(env: CloudflareEnv, options: BitbucketCodeReviewServiceOptions = {}) {
    this.fetchImplementation = options.fetch ?? defaultFetch;
    this.authorizationService =
      options.authorizationService ?? new BitbucketWorkspaceAccessTokenAuthorizationService(env);
  }

  async getPullRequest(input: BitbucketPullRequestRequest): Promise<BitbucketPullRequestResult> {
    const parsed = BitbucketPullRequestRequestSchema.safeParse(input);
    if (!parsed.success) return { success: false, reason: 'invalid_request' };
    if (!this.repositoryMatchesWorkspace(parsed.data)) {
      return { success: false, reason: 'repository_mismatch' };
    }

    const authorized = await this.authorizeWorkspace(parsed.data);
    if (!authorized.success) return authorized;

    const repositorySlug = parsed.data.repositoryFullName.slice(
      parsed.data.workspaceSlug.length + 1
    );
    const endpoint = `${BITBUCKET_API_PREFIX}/repositories/${encodeURIComponent(parsed.data.workspaceSlug)}/${encodeURIComponent(repositorySlug)}/pullrequests/${parsed.data.pullRequestId}`;
    let payload: unknown;
    try {
      payload = await this.requestJson(endpoint, authorized.workspace.authorization.token);
    } catch (error) {
      return this.mapProviderFailure(
        error,
        authorized.workspace.authorization,
        'pull_request_not_found'
      );
    }

    const pullRequest = BitbucketPullRequestPayloadSchema.safeParse(payload);
    if (!pullRequest.success || pullRequest.data.id !== parsed.data.pullRequestId) {
      return { success: false, reason: 'temporarily_unavailable' };
    }
    const source = normalizePullRequestSide(pullRequest.data.source, parsed.data);
    const destination = normalizePullRequestSide(pullRequest.data.destination, parsed.data);
    if (!source || !destination) return { success: false, reason: 'repository_mismatch' };

    let resolvedSourceSha: string;
    let resolvedDestinationSha: string;
    try {
      [resolvedSourceSha, resolvedDestinationSha] = await Promise.all([
        this.resolveCommitHash(parsed.data, source.sha, authorized.workspace.authorization.token),
        this.resolveCommitHash(
          parsed.data,
          destination.sha,
          authorized.workspace.authorization.token
        ),
      ]);
    } catch (error) {
      return this.mapProviderFailure(error, authorized.workspace.authorization);
    }

    const expectedUrl = `https://bitbucket.org/${parsed.data.repositoryFullName}/pull-requests/${parsed.data.pullRequestId}`;
    if (pullRequest.data.links.html.href !== expectedUrl) {
      return { success: false, reason: 'repository_mismatch' };
    }
    const authorUuid = normalizeBitbucketUuid(pullRequest.data.author.uuid);
    const updatedAt = new Date(pullRequest.data.updated_on);
    if (!authorUuid || !Number.isFinite(updatedAt.getTime())) {
      return { success: false, reason: 'temporarily_unavailable' };
    }

    return {
      success: true,
      pullRequest: {
        id: pullRequest.data.id,
        state: pullRequest.data.state,
        draft: pullRequest.data.draft,
        updatedOn: updatedAt.toISOString(),
        title: pullRequest.data.title,
        author: {
          uuid: authorUuid,
          displayName: pullRequest.data.author.display_name,
        },
        source: { ...source, sha: resolvedSourceSha },
        destination: { ...destination, sha: resolvedDestinationSha },
        url: expectedUrl,
      },
    };
  }

  async listWorkspaceWebhooks(
    input: BitbucketWorkspaceTarget
  ): Promise<BitbucketWorkspaceWebhookListResult> {
    const parsed = BitbucketWorkspaceTargetSchema.safeParse(input);
    if (!parsed.success) return { success: false, reason: 'invalid_request' };

    const authorized = await this.authorizeWorkspace(parsed.data);
    if (!authorized.success) return authorized;
    try {
      return {
        success: true,
        webhooks: await this.listAuthorizedWorkspaceWebhooks(authorized.workspace),
      };
    } catch (error) {
      return this.mapProviderFailure(error, authorized.workspace.authorization);
    }
  }

  async ensureWorkspaceWebhook(
    input: BitbucketEnsureWebhookRequest
  ): Promise<BitbucketEnsureWebhookResult> {
    const parsed = BitbucketEnsureWebhookRequestSchema.safeParse(input);
    if (
      !parsed.success ||
      !callbackMatchesIntegration(parsed.data.callbackUrl, parsed.data.integrationId)
    ) {
      return { success: false, reason: 'invalid_request' };
    }

    const authorized = await this.authorizeWorkspace(parsed.data);
    if (!authorized.success) return authorized;
    const body = this.webhookWriteBody(parsed.data.callbackUrl, parsed.data.secret);
    if (!body) return { success: false, reason: 'invalid_request' };

    try {
      let webhooks = await this.listAuthorizedWorkspaceWebhooks(authorized.workspace);
      let exactMatches = this.exactCallbackMatches(webhooks, parsed.data.callbackUrl);
      if (exactMatches.length === 0) {
        const created = await this.requestJson(
          authorized.workspace.hooksEndpoint,
          authorized.workspace.authorization.token,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          }
        );
        const parsedCreated = BitbucketWebhookPayloadSchema.safeParse(created);
        const createdWebhook = parsedCreated.success
          ? normalizeWebhookPayload(parsedCreated.data)
          : null;
        if (!createdWebhook || createdWebhook.callbackUrl !== parsed.data.callbackUrl) {
          throw new BitbucketCodeReviewProviderError('invalid_response');
        }
        webhooks = await this.listAuthorizedWorkspaceWebhooks(authorized.workspace);
        exactMatches = this.exactCallbackMatches(webhooks, parsed.data.callbackUrl);
      }
      const keeper = exactMatches[0];
      if (!keeper) throw new BitbucketCodeReviewProviderError('invalid_response');

      let duplicateDeletionError: unknown;
      for (const duplicate of exactMatches.slice(1)) {
        try {
          await this.deleteAuthorizedWorkspaceWebhook(authorized.workspace, duplicate.uuid);
        } catch (error) {
          duplicateDeletionError ??= error;
        }
      }
      if (duplicateDeletionError) throw duplicateDeletionError;

      const updated = await this.requestJson(
        `${authorized.workspace.hooksEndpoint}/${keeper.uuid}`,
        authorized.workspace.authorization.token,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body,
        }
      );
      const parsedUpdated = BitbucketWebhookPayloadSchema.safeParse(updated);
      const updatedWebhook = parsedUpdated.success
        ? normalizeWebhookPayload(parsedUpdated.data)
        : null;
      if (
        !updatedWebhook ||
        updatedWebhook.uuid !== keeper.uuid ||
        !this.isExpectedWebhook(updatedWebhook, parsed.data.callbackUrl)
      ) {
        throw new BitbucketCodeReviewProviderError('invalid_response');
      }

      const confirmed = this.exactCallbackMatches(
        await this.listAuthorizedWorkspaceWebhooks(authorized.workspace),
        parsed.data.callbackUrl
      );
      if (
        confirmed.length !== 1 ||
        confirmed[0]?.uuid !== keeper.uuid ||
        !this.isExpectedWebhook(confirmed[0], parsed.data.callbackUrl)
      ) {
        throw new BitbucketCodeReviewProviderError('invalid_response');
      }

      return {
        success: true,
        webhook: {
          ...confirmed[0],
          events: [...BITBUCKET_CODE_REVIEW_WEBHOOK_EVENTS],
        },
      };
    } catch (error) {
      return this.mapProviderFailure(error, authorized.workspace.authorization);
    }
  }

  async deleteWorkspaceWebhooks(
    input: BitbucketDeleteWebhookRequest
  ): Promise<BitbucketDeleteWebhookResult> {
    const parsed = BitbucketDeleteWebhookRequestSchema.safeParse(input);
    if (
      !parsed.success ||
      !callbackMatchesIntegration(parsed.data.callbackUrl, parsed.data.integrationId)
    ) {
      return { success: false, reason: 'invalid_request' };
    }

    const authorized = await this.authorizeWorkspace(parsed.data);
    if (!authorized.success) return authorized;

    try {
      const exactMatches = this.exactCallbackMatches(
        await this.listAuthorizedWorkspaceWebhooks(authorized.workspace),
        parsed.data.callbackUrl
      );
      let deletionError: unknown;
      for (const webhook of exactMatches) {
        try {
          await this.deleteAuthorizedWorkspaceWebhook(authorized.workspace, webhook.uuid);
        } catch (error) {
          deletionError ??= error;
        }
      }
      if (deletionError) throw deletionError;
      return { success: true };
    } catch (error) {
      return this.mapProviderFailure(error, authorized.workspace.authorization);
    }
  }

  private repositoryMatchesWorkspace(target: BitbucketPullRequestRequest): boolean {
    const [workspaceSlug, repositorySlug] = target.repositoryFullName.split('/');
    return Boolean(
      workspaceSlug && repositorySlug && workspaceSlug === target.workspaceSlug && repositorySlug
    );
  }

  private async resolveCommitHash(
    target: BitbucketPullRequestRequest,
    providerHash: string,
    accessToken: string
  ): Promise<string> {
    const normalizedHash = providerHash.toLowerCase();
    if (BitbucketFullCommitHashSchema.safeParse(normalizedHash).success) {
      return normalizedHash;
    }

    const repositorySlug = target.repositoryFullName.slice(target.workspaceSlug.length + 1);
    const endpoint = `${BITBUCKET_API_PREFIX}/repositories/${encodeURIComponent(target.workspaceSlug)}/${encodeURIComponent(repositorySlug)}/commit/${encodeURIComponent(normalizedHash)}`;
    const payload = await this.requestJson(endpoint, accessToken);
    const commit = BitbucketCommitPayloadSchema.safeParse(payload);
    const fullHash = commit.success ? commit.data.hash.toLowerCase() : null;
    if (!fullHash || !fullHash.startsWith(normalizedHash)) {
      throw new BitbucketCodeReviewProviderError('invalid_response');
    }
    return fullHash;
  }

  private async authorizeWorkspace(
    target: BitbucketWorkspaceTarget
  ): Promise<
    | { success: true; workspace: AuthorizedWorkspace }
    | { success: false; reason: BitbucketCodeReviewFailureReason }
  > {
    let authorization: BitbucketWorkspaceAccessTokenAuthorizationResult;
    try {
      authorization = await this.authorizationService.getAuthorization(target.owner);
    } catch {
      return { success: false, reason: 'temporarily_unavailable' };
    }
    if (authorization.status !== 'available') return mapAuthorizationFailure(authorization);
    if (authorization.organizationId !== target.owner.orgId) {
      return { success: false, reason: 'invalid_request' };
    }
    if (authorization.integrationId !== target.integrationId) {
      return { success: false, reason: 'integration_mismatch' };
    }
    if (
      authorization.workspace.uuid !== target.workspaceUuid ||
      authorization.workspace.slug !== target.workspaceSlug
    ) {
      return { success: false, reason: 'workspace_mismatch' };
    }
    if (!hasRequiredBitbucketWorkspaceAccessTokenScopes(authorization.providerScopes)) {
      return { success: false, reason: 'insufficient_permissions' };
    }

    return {
      success: true,
      workspace: {
        authorization,
        hooksEndpoint: `${BITBUCKET_API_PREFIX}/workspaces/${encodeURIComponent(target.workspaceSlug)}/hooks`,
      },
    };
  }

  private webhookWriteBody(callbackUrl: string, secret: string): string | null {
    const body = JSON.stringify({
      description: 'Kilo Code Reviewer',
      url: callbackUrl,
      active: true,
      events: [...BITBUCKET_CODE_REVIEW_WEBHOOK_EVENTS],
      secret,
    });
    return new TextEncoder().encode(body).byteLength <= BITBUCKET_MAX_WRITE_BODY_BYTES
      ? body
      : null;
  }

  private exactCallbackMatches(
    webhooks: BitbucketWorkspaceWebhook[],
    callbackUrl: string
  ): BitbucketWorkspaceWebhook[] {
    return webhooks
      .filter(webhook => webhook.callbackUrl === callbackUrl)
      .sort((left, right) => left.uuid.localeCompare(right.uuid));
  }

  private isExpectedWebhook(webhook: BitbucketWorkspaceWebhook, callbackUrl: string): boolean {
    return (
      webhook.callbackUrl === callbackUrl &&
      webhook.active &&
      webhook.secretSet &&
      hasExactWebhookEvents(webhook.events)
    );
  }

  private async listAuthorizedWorkspaceWebhooks(
    workspace: AuthorizedWorkspace
  ): Promise<BitbucketWorkspaceWebhook[]> {
    const webhooks: BitbucketWorkspaceWebhook[] = [];
    const webhookUuids = new Set<string>();
    const visited = new Set<string>();
    let endpoint: string | undefined =
      `${workspace.hooksEndpoint}?pagelen=${BITBUCKET_WEBHOOK_PAGE_LENGTH}`;

    for (let pageNumber = 0; endpoint; pageNumber += 1) {
      if (pageNumber >= BITBUCKET_MAX_WEBHOOK_PAGES || visited.has(endpoint)) {
        throw new BitbucketCodeReviewProviderError('invalid_response');
      }
      visited.add(endpoint);
      const payload = await this.requestJson(endpoint, workspace.authorization.token);
      const page = BitbucketWebhookPageSchema.safeParse(payload);
      if (!page.success) throw new BitbucketCodeReviewProviderError('invalid_response');

      for (const providerWebhook of page.data.values) {
        const webhook = normalizeWebhookPayload(providerWebhook);
        if (!webhook || webhookUuids.has(webhook.uuid)) {
          throw new BitbucketCodeReviewProviderError('invalid_response');
        }
        if (webhooks.length >= BITBUCKET_MAX_WEBHOOK_ITEMS) {
          throw new BitbucketCodeReviewProviderError('invalid_response');
        }
        webhookUuids.add(webhook.uuid);
        webhooks.push(webhook);
      }

      if (page.data.next && webhooks.length >= BITBUCKET_MAX_WEBHOOK_ITEMS) {
        throw new BitbucketCodeReviewProviderError('invalid_response');
      }
      endpoint = page.data.next
        ? validateWebhookNextLink(page.data.next, workspace.hooksEndpoint)
        : undefined;
    }

    return webhooks;
  }

  private async deleteAuthorizedWorkspaceWebhook(
    workspace: AuthorizedWorkspace,
    webhookUuid: string
  ): Promise<void> {
    const endpoint = `${workspace.hooksEndpoint}/${webhookUuid}`;
    let response: Response;
    try {
      response = await this.fetchImplementation(endpoint, {
        method: 'DELETE',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${workspace.authorization.token}`,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(BITBUCKET_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new BitbucketCodeReviewProviderError('request_failed');
    }
    if (
      (response.status >= 300 && response.status < 400) ||
      response.redirected ||
      (response.url !== '' && response.url !== endpoint)
    ) {
      await cancelResponseBody(response);
      throw new BitbucketCodeReviewProviderError('redirect_rejected');
    }
    if (response.status === 401) {
      await cancelResponseBody(response);
      throw new BitbucketCodeReviewProviderError('authentication_rejected', response.status);
    }
    if (response.status === 403) {
      await cancelResponseBody(response);
      throw new BitbucketCodeReviewProviderError('insufficient_permissions', response.status);
    }
    if (response.status !== 204 && response.status !== 404) {
      await cancelResponseBody(response);
      throw new BitbucketCodeReviewProviderError('request_failed', response.status);
    }
    await cancelResponseBody(response);
  }

  private async requestJson(
    endpoint: string,
    accessToken: string,
    init: RequestInit = {}
  ): Promise<unknown> {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new BitbucketCodeReviewProviderError('request_failed');
    }
    if (
      url.origin !== BITBUCKET_API_ORIGIN ||
      !url.pathname.startsWith('/2.0/') ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.hash !== '' ||
      url.href !== endpoint ||
      hasNonVisibleAscii(accessToken)
    ) {
      throw new BitbucketCodeReviewProviderError('request_failed');
    }
    if (init.body) {
      const bodyBytes =
        typeof init.body === 'string' ? new TextEncoder().encode(init.body).byteLength : Infinity;
      if (bodyBytes > BITBUCKET_MAX_WRITE_BODY_BYTES) {
        throw new BitbucketCodeReviewProviderError('request_failed');
      }
    }

    let response: Response;
    const signal = init.signal ?? AbortSignal.timeout(BITBUCKET_REQUEST_TIMEOUT_MS);
    try {
      response = await this.fetchImplementation(endpoint, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...init.headers,
        },
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      throw new BitbucketCodeReviewProviderError('request_failed', undefined, {
        endpointPath: url.pathname,
        endpointSearch: url.search,
        method: init.method ?? 'GET',
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : null,
        signalAborted: signal.aborted,
      });
    }

    if (
      (response.status >= 300 && response.status < 400) ||
      response.redirected ||
      (response.url !== '' && response.url !== endpoint)
    ) {
      await cancelResponseBody(response);
      throw new BitbucketCodeReviewProviderError('redirect_rejected');
    }
    if (response.status === 401) {
      await cancelResponseBody(response);
      throw new BitbucketCodeReviewProviderError('authentication_rejected', response.status);
    }
    if (response.status === 403) {
      await cancelResponseBody(response);
      throw new BitbucketCodeReviewProviderError('insufficient_permissions', response.status);
    }
    if (response.status === 404) {
      await cancelResponseBody(response);
      throw new BitbucketCodeReviewProviderError('not_found', response.status);
    }
    if (response.status < 200 || response.status >= 300) {
      await cancelResponseBody(response);
      throw new BitbucketCodeReviewProviderError('request_failed', response.status);
    }

    const contentType = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      await cancelResponseBody(response);
      throw new BitbucketCodeReviewProviderError('invalid_response');
    }
    const contentLength = response.headers.get('Content-Length');
    if (contentLength) {
      if (!/^[0-9]+$/.test(contentLength)) {
        await cancelResponseBody(response);
        throw new BitbucketCodeReviewProviderError('invalid_response');
      }
      if (Number(contentLength) > BITBUCKET_MAX_JSON_RESPONSE_BYTES) {
        await cancelResponseBody(response);
        throw new BitbucketCodeReviewProviderError('response_too_large');
      }
    }
    return readBoundedJson(response, BITBUCKET_MAX_JSON_RESPONSE_BYTES);
  }

  private async mapProviderFailure(
    error: unknown,
    authorization: BitbucketWorkspaceAccessTokenAuthorization,
    notFoundReason?: 'pull_request_not_found'
  ): Promise<{ success: false; reason: BitbucketCodeReviewFailureReason }> {
    if (!(error instanceof BitbucketCodeReviewProviderError)) throw error;
    const mappedReason =
      error.code === 'authentication_rejected'
        ? 'reconnect_required'
        : error.code === 'insufficient_permissions'
          ? 'insufficient_permissions'
          : error.code === 'not_found' && notFoundReason
            ? notFoundReason
            : 'temporarily_unavailable';
    console.warn('[bitbucket-code-review] Provider failure', {
      providerErrorCode: error.code,
      providerStatus: error.status ?? null,
      mappedReason,
      providerContext: error.context ?? null,
    });
    if (error.code === 'authentication_rejected') {
      await this.authorizationService.invalidateAuthorization(authorization, 'provider_rejected');
      return { success: false, reason: 'reconnect_required' };
    }
    if (error.code === 'insufficient_permissions') {
      return { success: false, reason: 'insufficient_permissions' };
    }
    if (error.code === 'not_found' && notFoundReason) {
      return { success: false, reason: notFoundReason };
    }
    return { success: false, reason: 'temporarily_unavailable' };
  }
}
