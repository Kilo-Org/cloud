import type { ConversationMember } from './types';

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
