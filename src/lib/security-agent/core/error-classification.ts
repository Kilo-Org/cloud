import type { TRPCError } from '@trpc/server';

export type AnalysisErrorCode =
  | 'CLONE_FAILED'
  | 'AUTH_FAILED'
  | 'REPO_NOT_FOUND'
  | 'SANDBOX_FAILED'
  | 'UNKNOWN';

type ClassifiedError = {
  code: AnalysisErrorCode;
  userMessage: string;
};

const CLONE_PATTERNS = [/\bgit\b.*\bclone\b/i, /\bfailed to clone\b/i, /\brepository\b.*\bfrom\b/i];

const AUTH_PATTERNS = [
  /\bauthenticat/i,
  /\bBad credentials\b/i,
  /\bcredentials?\b.*\b(failed|invalid|expired|rejected)\b/i,
  /\b(status|error|returned|HTTP)\s*:?\s*40[13]\b/i,
  /\bpermission\b.*\bdenied\b/i,
];

const NOT_FOUND_PATTERNS = [
  /\brepo(sitory)?\b.*\bnot found\b/i,
  /\bnot found\b.*\brepo(sitory)?\b/i,
  /\b404\b.*\brepo(sitory)?\b/i,
  /\brepo(sitory)?\b.*\b404\b/i,
  /\brepo(sitory)?\b.*\bdoes not exist\b/i,
  /\bno such\b.*\brepository\b/i,
];

/**
 * Classify a raw error into a structured code and user-friendly message.
 *
 * Order matters: clone patterns are checked first because a clone failure
 * message often also contains "not found" or auth-related substrings.
 */
export function classifyAnalysisError(error: unknown): ClassifiedError {
  const raw = error instanceof Error ? error.message : String(error);

  if (CLONE_PATTERNS.some(p => p.test(raw))) {
    return {
      code: 'CLONE_FAILED',
      userMessage:
        'Failed to clone the repository. Please verify it exists and your GitHub integration has access.',
    };
  }

  if (AUTH_PATTERNS.some(p => p.test(raw))) {
    return {
      code: 'AUTH_FAILED',
      userMessage:
        'GitHub authentication failed. Please reconnect your GitHub integration and try again.',
    };
  }

  if (NOT_FOUND_PATTERNS.some(p => p.test(raw))) {
    return {
      code: 'REPO_NOT_FOUND',
      userMessage: 'Repository not found. It may have been deleted, renamed, or made private.',
    };
  }

  return {
    code: 'UNKNOWN',
    userMessage: 'An unexpected error occurred. Please try again.',
  };
}

/** User-actionable errors that should not be reported as Sentry exceptions. */
export function isUserActionableError(code: AnalysisErrorCode): boolean {
  switch (code) {
    case 'CLONE_FAILED':
    case 'AUTH_FAILED':
    case 'REPO_NOT_FOUND':
      return true;
    case 'SANDBOX_FAILED':
    case 'UNKNOWN':
      return false;
  }
}

export function trpcCodeForAnalysisError(code: AnalysisErrorCode | undefined): TRPCError['code'] {
  switch (code) {
    case 'CLONE_FAILED':
      return 'BAD_REQUEST';
    case 'AUTH_FAILED':
      return 'PRECONDITION_FAILED';
    case 'REPO_NOT_FOUND':
      return 'NOT_FOUND';
    case 'SANDBOX_FAILED':
    case 'UNKNOWN':
    default:
      return 'INTERNAL_SERVER_ERROR';
  }
}
