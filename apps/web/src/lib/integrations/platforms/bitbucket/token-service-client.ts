import 'server-only';

import { z } from 'zod';
import {
  BITBUCKET_CODE_REVIEW_PULL_REQUEST_AUDIENCE,
  BITBUCKET_CODE_REVIEW_WEBHOOK_DELETE_AUDIENCE,
  BITBUCKET_CODE_REVIEW_WEBHOOK_ENSURE_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';
import { GIT_TOKEN_SERVICE_API_URL } from '@/lib/config.server';
import {
  BITBUCKET_REPOSITORY_LIST_AUDIENCE,
  generateInternalServiceToken,
  TOKEN_EXPIRY,
} from '@/lib/tokens';

export const BitbucketRepositorySchema = z
  .object({
    id: z.uuid(),
    workspaceUuid: z.uuid(),
    name: z.string().min(1),
    fullName: z.string().min(3),
    private: z.boolean(),
    defaultBranch: z.string().min(1).optional(),
  })
  .strict();

export const BitbucketRepositoryListResultSchema = z.discriminatedUnion('status', [
  z
    .object({ status: z.literal('available'), repositories: z.array(BitbucketRepositorySchema) })
    .strict(),
  z.object({ status: z.literal('invalid_request') }).strict(),
  z.object({ status: z.literal('not_connected') }).strict(),
  z.object({ status: z.literal('reconnect_required') }).strict(),
  z.object({ status: z.literal('insufficient_permissions') }).strict(),
  z.object({ status: z.literal('temporarily_unavailable') }).strict(),
]);

export type BitbucketRepository = z.infer<typeof BitbucketRepositorySchema>;
export type BitbucketRepositoryListResult = z.infer<typeof BitbucketRepositoryListResultSchema>;

export async function fetchBitbucketRepositoriesFromTokenService(
  kiloUserId: string,
  organizationId?: string
): Promise<BitbucketRepositoryListResult> {
  if (!GIT_TOKEN_SERVICE_API_URL) return { status: 'temporarily_unavailable' };
  const serviceToken = generateInternalServiceToken(kiloUserId, {
    expiresIn: TOKEN_EXPIRY.fiveMinutes,
    audience: BITBUCKET_REPOSITORY_LIST_AUDIENCE,
    organizationId,
  });

  let response: Response;
  try {
    response = await fetch(`${GIT_TOKEN_SERVICE_API_URL}/internal/bitbucket/repositories`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${serviceToken}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { status: 'temporarily_unavailable' };
  }
  if (!response.ok) return { status: 'temporarily_unavailable' };

  try {
    const parsed = BitbucketRepositoryListResultSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : { status: 'temporarily_unavailable' };
  } catch {
    return { status: 'temporarily_unavailable' };
  }
}

export function fetchBitbucketWorkspaceAccessTokenRepositoriesFromTokenService(
  kiloUserId: string,
  organizationId: string
): Promise<BitbucketRepositoryListResult> {
  return fetchBitbucketRepositoriesFromTokenService(kiloUserId, organizationId);
}

const BITBUCKET_CODE_REVIEW_RESPONSE_MAX_BYTES = 256_000;
const BITBUCKET_CODE_REVIEW_REQUEST_MAX_BYTES = 16_000;

const BitbucketCodeReviewFailureReasonSchema = z.enum([
  'invalid_request',
  'not_connected',
  'reconnect_required',
  'temporarily_unavailable',
  'insufficient_permissions',
  'integration_mismatch',
  'workspace_mismatch',
  'repository_mismatch',
  'pull_request_not_found',
]);

const BitbucketCodeReviewFailureSchema = z
  .object({
    success: z.literal(false),
    reason: BitbucketCodeReviewFailureReasonSchema,
  })
  .strict();

const BitbucketPullRequestSideSchema = z
  .object({
    repositoryUuid: z.string().uuid(),
    repositoryFullName: z.string().min(3).max(511),
    branch: z.string().min(1).max(1024),
    sha: z.string().regex(/^[0-9a-f]{7,64}$/),
  })
  .strict();

export const BitbucketPullRequestProjectionSchema = z
  .object({
    id: z.number().int().positive(),
    state: z.enum(['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']),
    draft: z.boolean(),
    updatedOn: z.string().datetime(),
    title: z.string().min(1).max(1024),
    author: z
      .object({
        uuid: z.string().uuid(),
        displayName: z.string().min(1).max(255),
      })
      .strict(),
    source: BitbucketPullRequestSideSchema,
    destination: BitbucketPullRequestSideSchema,
    url: z.string().url().max(2048),
  })
  .strict();

export const BitbucketPullRequestResultSchema = z.discriminatedUnion('success', [
  z
    .object({
      success: z.literal(true),
      pullRequest: BitbucketPullRequestProjectionSchema,
    })
    .strict(),
  BitbucketCodeReviewFailureSchema,
]);

export const BitbucketWorkspaceWebhookSchema = z
  .object({
    uuid: z.string().uuid(),
    callbackUrl: z.string().url().max(2048),
    active: z.boolean(),
    events: z
      .array(
        z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z]+:[a-z_]+$/)
      )
      .max(64)
      .refine(events => new Set(events).size === events.length),
    secretSet: z.boolean(),
  })
  .strict();

export const BitbucketEnsureWebhookResultSchema = z.discriminatedUnion('success', [
  z
    .object({
      success: z.literal(true),
      webhook: BitbucketWorkspaceWebhookSchema,
    })
    .strict(),
  BitbucketCodeReviewFailureSchema,
]);

export const BitbucketDeleteWebhookResultSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true) }).strict(),
  BitbucketCodeReviewFailureSchema,
]);

export type BitbucketPullRequestProjection = z.infer<typeof BitbucketPullRequestProjectionSchema>;
export type BitbucketPullRequestResult = z.infer<typeof BitbucketPullRequestResultSchema>;
export type BitbucketWorkspaceWebhook = z.infer<typeof BitbucketWorkspaceWebhookSchema>;
export type BitbucketEnsureWebhookResult = z.infer<typeof BitbucketEnsureWebhookResultSchema>;
export type BitbucketDeleteWebhookResult = z.infer<typeof BitbucketDeleteWebhookResultSchema>;

export type BitbucketCodeReviewWorkspaceIdentity = {
  integrationId: string;
  workspaceUuid: string;
  workspaceSlug: string;
};

export type BitbucketCodeReviewRepositoryIdentity = {
  repositoryUuid: string;
  repositoryFullName: string;
};

type TokenServiceCallOptions<Result> = {
  actorUserId: string;
  organizationId: string;
  audience: string;
  path: string;
  requestBody: object;
  resultSchema: z.ZodType<Result>;
  fallback: Result;
};

async function readBoundedTokenServiceJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('invalid_response');
  const contentType = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new Error('invalid_response');
  const contentLength = response.headers.get('Content-Length');
  if (
    contentLength &&
    (!/^[0-9]+$/.test(contentLength) ||
      Number(contentLength) > BITBUCKET_CODE_REVIEW_RESPONSE_MAX_BYTES)
  ) {
    throw new Error('invalid_response');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw new Error('invalid_response');
      totalBytes += chunk.value.byteLength;
      if (totalBytes > BITBUCKET_CODE_REVIEW_RESPONSE_MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The response remains rejected when cancellation itself fails.
        }
        throw new Error('invalid_response');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
}

async function callBitbucketCodeReviewTokenService<Result>(
  options: TokenServiceCallOptions<Result>
): Promise<Result> {
  if (!GIT_TOKEN_SERVICE_API_URL) return options.fallback;
  const requestBody = JSON.stringify(options.requestBody);
  if (new TextEncoder().encode(requestBody).byteLength > BITBUCKET_CODE_REVIEW_REQUEST_MAX_BYTES) {
    return options.fallback;
  }
  let serviceToken: string;
  try {
    serviceToken = generateInternalServiceToken(options.actorUserId, {
      expiresIn: TOKEN_EXPIRY.fiveMinutes,
      audience: options.audience,
      organizationId: options.organizationId,
    });
  } catch {
    return options.fallback;
  }

  let response: Response;
  try {
    response = await fetch(`${GIT_TOKEN_SERVICE_API_URL}${options.path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${serviceToken}`,
        'Content-Type': 'application/json',
      },
      body: requestBody,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return options.fallback;
  }
  if (!response.ok || response.redirected) return options.fallback;

  try {
    const parsed = options.resultSchema.safeParse(await readBoundedTokenServiceJson(response));
    return parsed.success ? parsed.data : options.fallback;
  } catch {
    return options.fallback;
  }
}

export async function fetchBitbucketPullRequestFromTokenService(params: {
  botUserId: string;
  organizationId: string;
  workspace: BitbucketCodeReviewWorkspaceIdentity;
  repository: BitbucketCodeReviewRepositoryIdentity;
  pullRequestId: number;
}): Promise<BitbucketPullRequestResult> {
  return callBitbucketCodeReviewTokenService({
    actorUserId: params.botUserId,
    organizationId: params.organizationId,
    audience: BITBUCKET_CODE_REVIEW_PULL_REQUEST_AUDIENCE,
    path: '/internal/bitbucket/code-review/pull-request',
    requestBody: { ...params.workspace, ...params.repository, pullRequestId: params.pullRequestId },
    resultSchema: BitbucketPullRequestResultSchema,
    fallback: { success: false, reason: 'temporarily_unavailable' },
  });
}

export async function ensureBitbucketWorkspaceWebhookFromTokenService(params: {
  managerUserId: string;
  organizationId: string;
  workspace: BitbucketCodeReviewWorkspaceIdentity;
  callbackUrl: string;
  secret: string;
}): Promise<BitbucketEnsureWebhookResult> {
  return callBitbucketCodeReviewTokenService({
    actorUserId: params.managerUserId,
    organizationId: params.organizationId,
    audience: BITBUCKET_CODE_REVIEW_WEBHOOK_ENSURE_AUDIENCE,
    path: '/internal/bitbucket/code-review/webhooks/ensure',
    requestBody: {
      ...params.workspace,
      callbackUrl: params.callbackUrl,
      secret: params.secret,
    },
    resultSchema: BitbucketEnsureWebhookResultSchema,
    fallback: { success: false, reason: 'temporarily_unavailable' },
  });
}

export async function deleteBitbucketWorkspaceWebhooksFromTokenService(params: {
  managerUserId: string;
  organizationId: string;
  workspace: BitbucketCodeReviewWorkspaceIdentity;
  callbackUrl: string;
}): Promise<BitbucketDeleteWebhookResult> {
  return callBitbucketCodeReviewTokenService({
    actorUserId: params.managerUserId,
    organizationId: params.organizationId,
    audience: BITBUCKET_CODE_REVIEW_WEBHOOK_DELETE_AUDIENCE,
    path: '/internal/bitbucket/code-review/webhooks/delete',
    requestBody: { ...params.workspace, callbackUrl: params.callbackUrl },
    resultSchema: BitbucketDeleteWebhookResultSchema,
    fallback: { success: false, reason: 'temporarily_unavailable' },
  });
}
