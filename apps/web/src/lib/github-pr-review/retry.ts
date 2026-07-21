import 'server-only';

import { TRPCError } from '@trpc/server';
import type { Octokit } from '@octokit/rest';

import { createGitHubPrReviewOctokit } from './client';
import {
  type ClassifiedGitHubError,
  classifyGitHubHttpError,
  classifyGitHubGraphQlErrors,
} from './errors';
import {
  getGitHubUserAccessToken,
  type GitHubUserAccessTokenConnected,
} from '@/lib/integrations/platforms/github/user-token-client';

export type CurrentCredential = Pick<
  GitHubUserAccessTokenConnected,
  'authorizationId' | 'credentialVersion'
>;

function throwTrpcFromClassification(classified: ClassifiedGitHubError): never {
  throw new TRPCError({
    code: classified.code,
    message: classified.message,
  });
}

function isHttp401(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const status = (error as { status?: unknown }).status;
  return status === 401;
}

async function reportAndThrowPrecondition(
  kiloUserId: string,
  credential: CurrentCredential
): Promise<never> {
  await getGitHubUserAccessToken(kiloUserId, {
    op: 'reportRejected',
    authorizationId: credential.authorizationId,
    credentialVersion: credential.credentialVersion,
  });
  throwTrpcFromClassification({
    code: 'PRECONDITION_FAILED',
    message: 'GitHub connection is no longer valid — reconnect',
  });
}

/**
 * Wraps a single GitHub call (REST or GraphQL) with the standard
 *   1. fetch credential
 *   2. invoke
 *   3. on 401 → rotate credential + retry once
 *   4. on second 401 → reportRejected + PRECONDITION_FAILED
 * orchestration. The wrapped call receives a fresh Octokit each time (a
 * rotate produces a new token).
 */
export async function withGitHubUserTokenRetry<T>(args: {
  kiloUserId: string;
  call: (octokit: Octokit) => Promise<T>;
}): Promise<T> {
  const first = await getGitHubUserAccessToken(args.kiloUserId, { op: 'fetch' });
  if (first.status !== 'connected') {
    throwTrpcFromClassification({
      code: 'PRECONDITION_FAILED',
      message: 'GitHub connection is no longer valid — reconnect',
    });
  }
  const firstOctokit = createGitHubPrReviewOctokit(first.credential.token);
  try {
    return await args.call(firstOctokit);
  } catch (error) {
    // A TRPCError is an already-classified failure (e.g. a GraphQL errors[]
    // entry, or a deliberate BAD_REQUEST) — surface it unchanged.
    if (error instanceof TRPCError) throw error;
    // Non-401 raw GitHub errors are classified here (this wrapper is the
    // single raw→tRPC boundary), so procedures let raw errors propagate.
    if (!isHttp401(error)) throwTrpcFromGitHubError(error);
    // First 401 — rotate and retry once.
    const rotate = await getGitHubUserAccessToken(args.kiloUserId, {
      op: 'rotate',
      staleAuthorizationId: first.credential.authorizationId,
      staleCredentialVersion: first.credential.credentialVersion,
    });
    if (rotate.status !== 'connected') {
      throwTrpcFromClassification({
        code: 'PRECONDITION_FAILED',
        message: 'GitHub connection is no longer valid — reconnect',
      });
    }
    const secondOctokit = createGitHubPrReviewOctokit(rotate.credential.token);
    try {
      return await args.call(secondOctokit);
    } catch (secondError) {
      if (secondError instanceof TRPCError) throw secondError;
      if (isHttp401(secondError)) {
        await reportAndThrowPrecondition(args.kiloUserId, {
          authorizationId: rotate.credential.authorizationId,
          credentialVersion: rotate.credential.credentialVersion,
        });
      }
      throwTrpcFromGitHubError(secondError);
    }
  }
}

/**
 * Classify an arbitrary error and throw the corresponding tRPC error. Used by
 * the read procedures to surface REST and GraphQL failures uniformly.
 */
export function throwTrpcFromGitHubError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  const classified = classifyGitHubHttpError(error);
  throwTrpcFromClassification(classified);
}

/**
 * For GraphQL responses, inspect the top-level `errors[]` array and throw a
 * tRPC error if non-empty. Octokit returns the body even when `errors[]` is
 * populated, so callers must check this after every GraphQL call.
 */
export function throwTrpcFromGraphQlErrors(
  errors: ReadonlyArray<{ type?: string; message?: string }> | undefined
): void {
  const classified = classifyGitHubGraphQlErrors(errors);
  if (classified) throwTrpcFromClassification(classified);
}
