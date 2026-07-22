import 'server-only';

import { z } from 'zod';
import { GITLAB_CREDENTIAL_AUDIT_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { GIT_TOKEN_SERVICE_API_URL } from '@/lib/config.server';
import { generateInternalServiceToken, TOKEN_EXPIRY } from '@/lib/tokens';

const MAX_RESPONSE_BYTES = 16_384;
const REQUEST_TIMEOUT_MS = 30_000;

const PrivateAuditCountsSchema = z
  .object({
    credentials: z.number().int().nonnegative(),
    secrets: z.number().int().nonnegative(),
    passedCredentials: z.number().int().nonnegative(),
    profileFailures: z.number().int().nonnegative(),
    configurationFailures: z.number().int().nonnegative(),
    parseFailures: z.number().int().nonnegative(),
    unknownKeyFailures: z.number().int().nonnegative(),
    decryptOrAadFailures: z.number().int().nonnegative(),
  })
  .strict();

export const GitLabCredentialPrivateAuditResponseSchema = z
  .object({
    activeKey: z
      .object({
        keyId: z.string().min(1),
        publicKeySha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .nullable(),
    counts: PrivateAuditCountsSchema,
    failingCredentials: z
      .object({
        profile: z.array(z.object({ integrationId: z.uuid(), credentialId: z.uuid() }).strict()),
        configuration: z.array(
          z.object({ integrationId: z.uuid(), credentialId: z.uuid() }).strict()
        ),
        parse: z.array(z.object({ integrationId: z.uuid(), credentialId: z.uuid() }).strict()),
        unknownKey: z.array(z.object({ integrationId: z.uuid(), credentialId: z.uuid() }).strict()),
        decryptOrAad: z.array(
          z.object({ integrationId: z.uuid(), credentialId: z.uuid() }).strict()
        ),
      })
      .strict(),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type GitLabCredentialPrivateAuditResponse = z.infer<
  typeof GitLabCredentialPrivateAuditResponseSchema
>;

export type GitLabCredentialPrivateAuditClientResult =
  | { kind: 'success'; audit: GitLabCredentialPrivateAuditResponse }
  | { kind: 'terminal_error'; errorCode: string }
  | { kind: 'retryable_error'; errorCode: string };

export async function readBoundedGitLabCredentialResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('invalid_response');
  if (
    response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !==
    'application/json'
  ) {
    throw new Error('invalid_response');
  }
  const contentLength = response.headers.get('Content-Length');
  if (
    contentLength &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)
  ) {
    throw new Error('invalid_response');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw new Error('invalid_response');
      length += chunk.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error('invalid_response');
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
}

export async function requestGitLabCredentialPrivateAudit(input: {
  requestedByUserId: string;
  cursor: string | null;
  limit?: number;
}): Promise<GitLabCredentialPrivateAuditClientResult> {
  if (!GIT_TOKEN_SERVICE_API_URL)
    return { kind: 'retryable_error', errorCode: 'audit_unavailable' };
  let token: string;
  try {
    token = generateInternalServiceToken(input.requestedByUserId, {
      expiresIn: TOKEN_EXPIRY.fiveMinutes,
      audience: GITLAB_CREDENTIAL_AUDIT_AUDIENCE,
    });
  } catch {
    return { kind: 'terminal_error', errorCode: 'audit_authentication_unavailable' };
  }
  let response: Response;
  try {
    response = await fetch(`${GIT_TOKEN_SERVICE_API_URL}/internal/gitlab/credential-audit`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...(input.cursor ? { cursor: input.cursor } : {}),
        limit: input.limit ?? 100,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'retryable_error', errorCode: 'audit_request_failed' };
  }
  if (response.redirected || response.status === 401 || response.status === 403) {
    return {
      kind: 'terminal_error',
      errorCode: response.status === 403 ? 'requester_not_admin' : 'audit_unauthorized',
    };
  }
  if (response.status >= 500) return { kind: 'retryable_error', errorCode: 'audit_unavailable' };
  if (!response.ok) return { kind: 'terminal_error', errorCode: 'audit_invalid_response' };
  try {
    const audit = GitLabCredentialPrivateAuditResponseSchema.safeParse(
      await readBoundedGitLabCredentialResponse(response)
    );
    return audit.success
      ? { kind: 'success', audit: audit.data }
      : { kind: 'terminal_error', errorCode: 'audit_invalid_response' };
  } catch {
    return { kind: 'terminal_error', errorCode: 'audit_invalid_response' };
  }
}
