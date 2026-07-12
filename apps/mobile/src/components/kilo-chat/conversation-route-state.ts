import {
  type ConversationMember,
  conversationSandboxIdFromMembers,
  KiloChatApiError,
} from '@kilocode/kilo-chat';

type ConversationRouteDetailState = {
  data: { title: string | null; members: ConversationMember[] } | null | undefined;
  error: unknown;
  isError: boolean;
};

type ConversationRouteDecision = 'pending' | 'ready' | 'retryable-error' | 'not-found';

function isConversationNotFoundError(error: unknown): boolean {
  const status = error instanceof KiloChatApiError ? error.status : undefined;
  return status === 400 || status === 403 || status === 404;
}

export function getConversationRouteDecision({
  detail,
  routeSandboxId,
}: {
  detail: ConversationRouteDetailState;
  routeSandboxId: string;
}): ConversationRouteDecision {
  // Only a confirmed not-found/forbidden response redirects away — it's
  // authoritative even over stale cached data (access was actually revoked).
  if (detail.isError && isConversationNotFoundError(detail.error)) {
    return 'not-found';
  }
  // Cached data wins: a failed background refetch (isError true, data
  // retained by TanStack) must not replace an already-rendered conversation
  // with a full-screen error. Transport/server errors only take over the
  // screen when there is no data to show yet.
  if (detail.data !== null && detail.data !== undefined) {
    return conversationSandboxIdFromMembers(detail.data.members) !== routeSandboxId
      ? 'not-found'
      : 'ready';
  }
  if (detail.isError) {
    return 'retryable-error';
  }
  return 'pending';
}
