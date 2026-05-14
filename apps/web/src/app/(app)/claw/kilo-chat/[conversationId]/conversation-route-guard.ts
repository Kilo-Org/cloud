import { conversationSandboxIdFromMembers, type ConversationMember } from '@kilocode/kilo-chat';

export type KiloChatInstanceRouteDecision =
  | 'pending'
  | 'ready'
  | 'status-error'
  | 'redirect-no-instance';

export type ConversationRouteDecision =
  | 'pending'
  | 'ready'
  | 'status-error'
  | 'not-found'
  | 'redirect-no-instance';

export { conversationSandboxIdFromMembers };

export function kiloChatInstanceRouteDecision({
  instanceStatus,
  isInstanceError,
  isInstanceLoading,
}: {
  instanceStatus: string | null;
  isInstanceError: boolean;
  isInstanceLoading: boolean;
}): KiloChatInstanceRouteDecision {
  if (isInstanceLoading) {
    return 'pending';
  }
  if (isInstanceError) {
    return 'status-error';
  }
  return instanceStatus ? 'ready' : 'redirect-no-instance';
}

export function conversationRouteDecision({
  conversationMembers,
  isInstanceError,
  isInstanceLoading,
  isLeaving,
  routeSandboxId,
}: {
  conversationMembers: ConversationMember[] | undefined;
  isInstanceError: boolean;
  isInstanceLoading: boolean;
  isLeaving: boolean;
  routeSandboxId: string | null;
}): ConversationRouteDecision {
  if (isLeaving) {
    return 'pending';
  }
  if (isInstanceError) {
    return 'status-error';
  }
  if (routeSandboxId === null) {
    return isInstanceLoading ? 'pending' : 'redirect-no-instance';
  }
  if (conversationMembers === undefined) {
    return 'pending';
  }
  if (conversationSandboxIdFromMembers(conversationMembers) !== routeSandboxId) {
    return 'not-found';
  }
  return 'ready';
}
