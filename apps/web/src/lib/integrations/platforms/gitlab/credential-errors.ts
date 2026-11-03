import { TRPCError } from '@trpc/server';
import { GitLabAuthenticationError } from './adapter';

/**
 * The credential broker's definitive refusal: the stored integration credential
 * cannot be used until the owner reconnects.
 */
export const GITLAB_RECONNECT_REQUIRED_MESSAGE = 'GitLab integration must be reconnected';

/**
 * True when the error says the stored GitLab credential cannot be used as-is:
 * a provider 401 (directly, or wrapped by a service call) or the credential
 * broker's definitive reconnect refusal. Role guidance cannot fix either case,
 * so callers route them to a reconnect message.
 */
export function isGitLabReconnectRequiredError(error: unknown): boolean {
  if (error instanceof GitLabAuthenticationError) return true;
  if (error instanceof TRPCError) {
    if (error.code !== 'UNAUTHORIZED') return false;
    return (
      error.message === GITLAB_RECONNECT_REQUIRED_MESSAGE ||
      error.cause instanceof GitLabAuthenticationError
    );
  }
  return error instanceof Error && error.cause instanceof GitLabAuthenticationError;
}
