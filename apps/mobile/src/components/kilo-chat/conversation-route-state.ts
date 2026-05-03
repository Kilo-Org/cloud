import {
  type ConversationMember,
  conversationSandboxIdFromMembers,
  KiloChatApiError,
} from '@kilocode/kilo-chat';

type ConversationRouteDetailState = {
  data: { title: string | null; members: ConversationMember[] } | null | undefined;
  isError: boolean;
};

type ConversationRouteDecision = 'pending' | 'ready' | 'error' | 'not-found';

export function getConversationRouteErrorMessage(error: unknown): string {
  const status = error instanceof KiloChatApiError ? error.status : undefined;
  if (status === 400 || status === 403 || status === 404) {
    return 'Conversation not found';
  }
  return 'Failed to load conversation';
}

export function getConversationRouteDecision({
  detail,
  routeSandboxId,
}: {
  detail: ConversationRouteDetailState;
  routeSandboxId: string;
}): ConversationRouteDecision {
  if (detail.isError) {
    return 'error';
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
