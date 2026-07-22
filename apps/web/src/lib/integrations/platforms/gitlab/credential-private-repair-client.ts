import 'server-only';

import { z } from 'zod';
import { GITLAB_CREDENTIAL_REPAIR_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { GIT_TOKEN_SERVICE_API_URL } from '@/lib/config.server';
import { generateInternalServiceToken, TOKEN_EXPIRY } from '@/lib/tokens';
import { readBoundedGitLabCredentialResponse } from './credential-private-audit-client';

const REQUEST_TIMEOUT_MS = 30_000;
const RepairIdSchema = z.object({ integrationId: z.uuid(), credentialId: z.uuid() }).strict();

export const GitLabCredentialPrivateRepairResponseSchema = z
  .object({
    counts: z
      .object({
        candidates: z.number().int().nonnegative(),
        repaired: z.number().int().nonnegative(),
        alreadyHealthy: z.number().int().nonnegative(),
        profileFailures: z.number().int().nonnegative(),
        configurationFailures: z.number().int().nonnegative(),
        parseFailures: z.number().int().nonnegative(),
        unknownKeyFailures: z.number().int().nonnegative(),
        unrepairableFailures: z.number().int().nonnegative(),
        writeConflicts: z.number().int().nonnegative(),
      })
      .strict(),
    failures: z
      .object({
        profile: z.array(RepairIdSchema),
        configuration: z.array(RepairIdSchema),
        parse: z.array(RepairIdSchema),
        unknownKey: z.array(RepairIdSchema),
        unrepairable: z.array(RepairIdSchema),
        writeConflict: z.array(RepairIdSchema),
      })
      .strict(),
    nextCursor: z.uuid().nullable(),
  })
  .strict();

export type GitLabCredentialPrivateRepairResponse = z.infer<
  typeof GitLabCredentialPrivateRepairResponseSchema
>;

export type GitLabCredentialPrivateRepairClientResult =
  | { kind: 'success'; repair: GitLabCredentialPrivateRepairResponse }
  | { kind: 'terminal_error'; errorCode: string }
  | { kind: 'retryable_error'; errorCode: string };

export async function requestGitLabCredentialPrivateRepair(input: {
  requestedByUserId: string;
  afterId: string | null;
  limit?: number;
}): Promise<GitLabCredentialPrivateRepairClientResult> {
  if (!GIT_TOKEN_SERVICE_API_URL) {
    return { kind: 'retryable_error', errorCode: 'repair_unavailable' };
  }
  let token: string;
  try {
    token = generateInternalServiceToken(input.requestedByUserId, {
      expiresIn: TOKEN_EXPIRY.fiveMinutes,
      audience: GITLAB_CREDENTIAL_REPAIR_AUDIENCE,
    });
  } catch {
    return { kind: 'terminal_error', errorCode: 'repair_authentication_unavailable' };
  }

  let response: Response;
  try {
    response = await fetch(`${GIT_TOKEN_SERVICE_API_URL}/internal/gitlab/credential-repair`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...(input.afterId ? { afterId: input.afterId } : {}),
        limit: input.limit ?? 100,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'retryable_error', errorCode: 'repair_request_failed' };
  }
  if (response.redirected || response.status === 401 || response.status === 403) {
    return {
      kind: 'terminal_error',
      errorCode: response.status === 403 ? 'requester_not_admin' : 'repair_unauthorized',
    };
  }
  if (response.status >= 500) return { kind: 'retryable_error', errorCode: 'repair_unavailable' };
  if (!response.ok) return { kind: 'terminal_error', errorCode: 'repair_invalid_response' };

  try {
    const repair = GitLabCredentialPrivateRepairResponseSchema.safeParse(
      await readBoundedGitLabCredentialResponse(response)
    );
    return repair.success
      ? { kind: 'success', repair: repair.data }
      : { kind: 'terminal_error', errorCode: 'repair_invalid_response' };
  } catch {
    return { kind: 'terminal_error', errorCode: 'repair_invalid_response' };
  }
}
