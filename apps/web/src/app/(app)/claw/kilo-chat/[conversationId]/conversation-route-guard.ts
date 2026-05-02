import type { ConversationMember } from '@kilocode/kilo-chat';

export type ConversationRouteDecision = 'pending' | 'ready' | 'not-found' | 'redirect-no-instance';

const kiloclawBotMemberPrefix = 'bot:kiloclaw:';

export function conversationSandboxIdFromMembers(members: ConversationMember[]): string | null {
  for (const member of members) {
    if (member.kind !== 'bot' || !member.id.startsWith(kiloclawBotMemberPrefix)) {
      continue;
    }
    const sandboxId = member.id.slice(kiloclawBotMemberPrefix.length);
    if (sandboxId.length > 0) {
      return sandboxId;
    }
  }
  return null;
}

export function conversationRouteDecision({
  conversationMembers,
  isInstanceLoading,
  isLeaving,
  routeSandboxId,
}: {
  conversationMembers: ConversationMember[] | undefined;
  isInstanceLoading: boolean;
  isLeaving: boolean;
  routeSandboxId: string | null;
}): ConversationRouteDecision {
  if (isLeaving) {
    return 'pending';
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
