import 'server-only';

import { z } from 'zod';
import { GITLAB_CREDENTIAL_BROKER_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { GIT_TOKEN_SERVICE_API_URL } from '@/lib/config.server';
import { generateInternalServiceToken, TOKEN_EXPIRY } from '@/lib/tokens';

const GITLAB_CREDENTIAL_RESPONSE_MAX_BYTES = 16_384;
const GITLAB_CREDENTIAL_REQUEST_TIMEOUT_MS = 30_000;

export const GitLabCredentialSelectorSchema = z.discriminatedUnion('credential', [
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

export const GitLabCredentialBrokerResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('available'),
      token: z.string().min(1).max(10_000),
      instanceUrl: z.url().max(2048),
      glabIsOAuth2: z.boolean(),
    })
    .strict(),
  z.object({ status: z.literal('invalid_request') }).strict(),
  z.object({ status: z.literal('not_connected') }).strict(),
  z.object({ status: z.literal('reconnect_required') }).strict(),
  z.object({ status: z.literal('temporarily_unavailable') }).strict(),
]);

export type GitLabCredentialActor = {
  userId: string;
  organizationId?: string;
};
export type GitLabCredentialSelector = z.infer<typeof GitLabCredentialSelectorSchema>;
export type GitLabCredentialBrokerResult = z.infer<typeof GitLabCredentialBrokerResultSchema>;

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('invalid_response');
  const contentType = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new Error('invalid_response');
  const contentLength = response.headers.get('Content-Length');
  if (
    contentLength &&
    (!/^[0-9]+$/.test(contentLength) ||
      Number(contentLength) > GITLAB_CREDENTIAL_RESPONSE_MAX_BYTES)
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
      if (totalBytes > GITLAB_CREDENTIAL_RESPONSE_MAX_BYTES) {
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
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
}

export async function fetchGitLabCredential(
  actor: GitLabCredentialActor,
  selector: GitLabCredentialSelector
): Promise<GitLabCredentialBrokerResult> {
  const parsedSelector = GitLabCredentialSelectorSchema.safeParse(selector);
  if (!parsedSelector.success) return { status: 'invalid_request' };
  if (!GIT_TOKEN_SERVICE_API_URL) return { status: 'temporarily_unavailable' };

  let serviceToken: string;
  try {
    serviceToken = generateInternalServiceToken(actor.userId, {
      expiresIn: TOKEN_EXPIRY.fiveMinutes,
      audience: GITLAB_CREDENTIAL_BROKER_AUDIENCE,
      organizationId: actor.organizationId,
    });
  } catch {
    return { status: 'temporarily_unavailable' };
  }

  let response: Response;
  try {
    response = await fetch(`${GIT_TOKEN_SERVICE_API_URL}/internal/gitlab/credentials`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${serviceToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(parsedSelector.data),
      redirect: 'error',
      signal: AbortSignal.timeout(GITLAB_CREDENTIAL_REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { status: 'temporarily_unavailable' };
  }
  if (!response.ok || response.redirected) return { status: 'temporarily_unavailable' };

  try {
    const parsedResult = GitLabCredentialBrokerResultSchema.safeParse(
      await readBoundedJson(response)
    );
    return parsedResult.success ? parsedResult.data : { status: 'temporarily_unavailable' };
  } catch {
    return { status: 'temporarily_unavailable' };
  }
}
