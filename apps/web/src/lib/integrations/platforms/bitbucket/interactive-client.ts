import 'server-only';

import { z } from 'zod';
import { serializeReviewWriteRequest } from '@kilocode/app-shared/provider-review';
import { GIT_TOKEN_SERVICE_API_URL } from '@/lib/config.server';
import { generateInternalServiceToken, TOKEN_EXPIRY } from '@/lib/tokens';
import {
  BitbucketInteractiveMetadataSchema,
  type BitbucketInteractiveData,
  type BitbucketInteractiveMetadata,
  type BitbucketInteractiveOperation,
  type BitbucketInteractiveRequest,
  type BitbucketInteractiveResponse,
  type BitbucketInteractiveResult,
  type BitbucketInteractiveServiceSuccess,
} from '../../../../../../../services/git-token-service/src/bitbucket-interactive-api';
import {
  BitbucketApiError,
  readBoundedBitbucketBody,
} from '../../../../../../../services/git-token-service/src/bitbucket-safe-transport';
import type {
  BitbucketCodeReviewRepositoryIdentity,
  BitbucketCodeReviewWorkspaceIdentity,
} from './token-service-client';

export type {
  BitbucketInteractiveMetadata,
  BitbucketInteractiveRequest,
  BitbucketInteractiveResponse,
  BitbucketInteractiveResult,
  BitbucketInteractiveServiceSuccess,
};
export const BITBUCKET_INTERACTIVE_PATH = '/internal/bitbucket/interactive-review';
export const BITBUCKET_INTERACTIVE_AUDIENCE = 'git-token-service:bitbucket-interactive-review';

const failureReason = z.enum([
  'invalid_request',
  'not_connected',
  'reconnect_required',
  'temporarily_unavailable',
  'insufficient_permissions',
  'integration_mismatch',
  'workspace_mismatch',
  'repository_mismatch',
  'not_found',
  'rate_limited',
  'conflict',
  'request_too_large',
  'response_too_large',
  'invalid_response',
  'redirect_rejected',
  'request_timed_out',
  'transport_failed',
  'authentication_rejected',
  'provider_unavailable',
  'request_failed',
  'invalid_pagination',
  'page_limit_exceeded',
  'item_limit_exceeded',
]);
const resultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.union([z.literal(200), z.literal(201)]),
    data: z.json(),
    next: z.string().optional(),
    location: z.string().optional(),
  }),
  z.strictObject({ status: z.literal(202), data: z.json(), location: z.string().min(1) }),
  z.strictObject({ status: z.literal(204), data: z.null() }),
]);
export const BitbucketInteractiveServiceResultSchema = z.discriminatedUnion('success', [
  z.strictObject({
    success: z.literal(true),
    result: resultSchema,
    metadata: BitbucketInteractiveMetadataSchema,
  }),
  z.strictObject({ success: z.literal(false), reason: failureReason }),
]);

export class BitbucketInteractiveClientError extends Error {
  constructor(readonly code: z.infer<typeof failureReason>) {
    super(code);
    this.name = 'BitbucketInteractiveClientError';
  }
}

// The Worker authenticates these claims, resolves the existing credential, and authorizes each operation.
// No provider token, arbitrary provider host, or automatic write retry belongs to this client.
export function createBitbucketInteractiveClient(options: {
  actorUserId: string;
  organizationId: string;
  workspace: BitbucketCodeReviewWorkspaceIdentity;
  repository: BitbucketCodeReviewRepositoryIdentity;
  fetch?: typeof fetch;
}) {
  return {
    async execute<K extends BitbucketInteractiveOperation>(
      request: BitbucketInteractiveRequest<K>
    ): Promise<BitbucketInteractiveResponse<BitbucketInteractiveData<K>>> {
      if (!options.organizationId || !options.actorUserId)
        throw new BitbucketInteractiveClientError('invalid_request');
      let body: string;
      try {
        body = serializeReviewWriteRequest({
          ...options.workspace,
          ...options.repository,
          request,
        });
      } catch {
        throw new BitbucketInteractiveClientError('request_too_large');
      }
      if (!GIT_TOKEN_SERVICE_API_URL)
        throw new BitbucketInteractiveClientError('temporarily_unavailable');
      const endpoint = `${GIT_TOKEN_SERVICE_API_URL.replace(/\/$/, '')}${BITBUCKET_INTERACTIVE_PATH}`;
      const signal = AbortSignal.timeout(30_000);
      try {
        const serviceToken = generateInternalServiceToken(options.actorUserId, {
          expiresIn: TOKEN_EXPIRY.fiveMinutes,
          audience: BITBUCKET_INTERACTIVE_AUDIENCE,
          organizationId: options.organizationId,
        });
        const response = await (options.fetch ?? globalThis.fetch)(endpoint, {
          method: 'POST',
          body,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${serviceToken}`,
          },
          redirect: 'manual',
          signal,
        });
        if (
          (response.status >= 300 && response.status < 400) ||
          response.redirected ||
          (response.url !== '' && response.url !== endpoint)
        ) {
          void response.body?.cancel().catch(() => undefined);
          throw new BitbucketInteractiveClientError('redirect_rejected');
        }
        if (!response.ok) {
          throw new BitbucketInteractiveClientError(
            response.status === 403
              ? 'insufficient_permissions'
              : response.status === 413
                ? 'request_too_large'
                : response.status === 429
                  ? 'rate_limited'
                  : 'temporarily_unavailable'
          );
        }
        if (
          response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
          'application/json'
        ) {
          throw new BitbucketInteractiveClientError('invalid_response');
        }
        const bytes = await readBoundedBitbucketBody(response, signal);
        let payload: unknown;
        try {
          payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch {
          throw new BitbucketInteractiveClientError('invalid_response');
        }
        const parsed = BitbucketInteractiveServiceResultSchema.safeParse(payload);
        if (!parsed.success) throw new BitbucketInteractiveClientError('invalid_response');
        if (!parsed.data.success) throw new BitbucketInteractiveClientError(parsed.data.reason);
        // The authenticated Worker selects the generated operation type. The wire envelope is validated above.
        return {
          ...(parsed.data.result as BitbucketInteractiveResult<BitbucketInteractiveData<K>>),
          metadata: parsed.data.metadata,
        };
      } catch (error) {
        if (error instanceof BitbucketInteractiveClientError)
          throw new BitbucketInteractiveClientError(error.code);
        if (error instanceof BitbucketApiError && failureReason.safeParse(error.code).success) {
          throw new BitbucketInteractiveClientError(failureReason.parse(error.code));
        }
        throw new BitbucketInteractiveClientError(
          signal.aborted ? 'request_timed_out' : 'temporarily_unavailable'
        );
      }
    },
  };
}
