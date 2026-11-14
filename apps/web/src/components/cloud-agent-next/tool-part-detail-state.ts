import type { QueryClient } from '@tanstack/react-query';
import { readToolPartDetail } from '@kilocode/cloud-agent-sdk/tool-part-detail';
import type { ToolPart } from './types';

function errorData(error: unknown): { code?: unknown; httpStatus?: unknown } | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const data: unknown = Reflect.get(error, 'data');
  return data !== null && typeof data === 'object' ? data : undefined;
}

/** Denied or missing sessions and rows are terminal; retrying cannot reveal them. */
export function isTerminalToolDetailError(error: unknown): boolean {
  const data = errorData(error);
  return (
    data?.code === 'FORBIDDEN' ||
    data?.code === 'UNAUTHORIZED' ||
    data?.code === 'NOT_FOUND' ||
    data?.httpStatus === 403 ||
    data?.httpStatus === 404
  );
}

/** One bounded retry for transient failures; known failures surface immediately. */
export function shouldRetryToolDetail(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1 || isTerminalToolDetailError(error)) return false;
  const status = errorData(error)?.httpStatus;
  return typeof status !== 'number' || status >= 500;
}

const TOOL_DETAIL_ROOT = 'cloud-agent-tool-detail';

/** The signed-in user, account, and workspace session a transcript is read in. */
export type ToolDetailScope = {
  userId: string;
  organizationId: string | null;
  cloudAgentSessionId: string;
};

/**
 * One entry per account, workspace session, native session, part, and preview
 * revision. A newer revision is a new entry, so stale details are never shown
 * as current.
 */
export function toolDetailQueryKey(scope: ToolDetailScope, part: ToolPart, revision: number) {
  return [
    TOOL_DETAIL_ROOT,
    scope.userId,
    scope.organizationId ?? 'personal',
    scope.cloudAgentSessionId,
    part.sessionID,
    part.messageID,
    part.id,
    revision,
  ] as const;
}

/**
 * Retires fetched details of a native session, as for a denied or missing
 * session. `inactive` keeps entries that mounted cards are reading, so a denial
 * observed by one card does not restart the others.
 */
export function removeToolDetailQueries(
  queryClient: QueryClient,
  kiloSessionId: string,
  type: 'all' | 'inactive' = 'all'
): void {
  queryClient.removeQueries({
    queryKey: [TOOL_DETAIL_ROOT],
    type,
    predicate: query => query.queryKey[4] === kiloSessionId,
  });
}

export type ToolDetailState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'complete' }
  | { status: 'unavailable'; message: string }
  | { status: 'error'; message: string };

export type ToolDetailView = { part: ToolPart; state: ToolDetailState };

const UNAVAILABLE = 'The full output is no longer available. Showing a preview.';
const TOO_LARGE = 'The full output is too large to show here. Showing a preview.';
const FAILED = 'Couldn’t load the full output. Showing a preview.';

/**
 * The part a card renders and the state of its complete details. The preview
 * stays visible until a matching complete part for the same or a newer
 * revision arrives. Absence is reported as unavailable, never as empty output.
 */
export function deriveToolDetailView(input: {
  preview: ToolPart;
  revision: number;
  requested: boolean;
  scoped: boolean;
  query: { status: 'pending' | 'error' | 'success'; data: unknown; error: unknown };
}): ToolDetailView {
  const { preview } = input;
  if (!input.requested) return { part: preview, state: { status: 'idle' } };
  if (!input.scoped)
    return { part: preview, state: { status: 'unavailable', message: UNAVAILABLE } };
  if (input.query.status === 'pending') return { part: preview, state: { status: 'loading' } };
  if (input.query.status === 'error') {
    return {
      part: preview,
      state: isTerminalToolDetailError(input.query.error)
        ? { status: 'unavailable', message: UNAVAILABLE }
        : { status: 'error', message: FAILED },
    };
  }
  let detail: ReturnType<typeof readToolPartDetail>;
  try {
    detail = readToolPartDetail(input.query.data, preview);
  } catch {
    return { part: preview, state: { status: 'error', message: FAILED } };
  }
  if (detail.kind === 'too_large')
    return { part: preview, state: { status: 'unavailable', message: TOO_LARGE } };
  if (detail.kind !== 'found' || detail.revision < input.revision || detail.part.type !== 'tool')
    return { part: preview, state: { status: 'unavailable', message: UNAVAILABLE } };
  return { part: detail.part, state: { status: 'complete' } };
}
