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

export type ConversationRouteDecision = 'pending' | 'ready' | 'retryable-error' | 'not-found';

function isConversationNotFoundError(error: unknown): boolean {
  const status = error instanceof KiloChatApiError ? error.status : undefined;
  return status === 400 || status === 403 || status === 404;
}

export function getConversationRouteErrorMessage(error: unknown): string {
  return isConversationNotFoundError(error)
    ? 'Conversation not found'
    : 'Failed to load conversation';
}

export function getConversationRouteDecision({
  detail,
  routeSandboxId,
}: {
  detail: ConversationRouteDetailState;
  routeSandboxId: string;
}): ConversationRouteDecision {
  if (detail.isError) {
    // Only a confirmed not-found/forbidden response should redirect away —
    // transport/server errors are retryable in place (see T2.9).
    return isConversationNotFoundError(detail.error) ? 'not-found' : 'retryable-error';
  }
  if (detail.data === null || detail.data === undefined) {
    return 'pending';
  }
  if (conversationSandboxIdFromMembers(detail.data.members) !== routeSandboxId) {
    return 'not-found';
  }
  return 'ready';
}

export function shouldRenderConversationScreen({
  detail,
  routeSandboxId,
}: {
  detail: ConversationRouteDetailState;
  routeSandboxId: string;
}): boolean {
  return getConversationRouteDecision({ detail, routeSandboxId }) === 'ready';
}
