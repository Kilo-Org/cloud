export type TypingEventKind = 'typing' | 'typing.stop';

type TypingEventInput = {
  event: TypingEventKind;
  expectedContext: string;
  eventContext: string;
  memberId: string;
  currentUserId: string | null;
};

export function applyTypingEventToMembers(
  memberIds: readonly string[],
  input: TypingEventInput
): string[] {
  if (input.eventContext !== input.expectedContext || input.memberId === input.currentUserId) {
    return [...memberIds];
  }

  if (input.event === 'typing.stop') {
    return memberIds.filter(memberId => memberId !== input.memberId);
  }

  if (memberIds.includes(input.memberId)) {
    return [...memberIds];
  }
  return [...memberIds, input.memberId];
}

export function typingIndicatorLabel(memberIds: readonly string[]): string | undefined {
  const memberId = memberIds[0];
  if (!memberId) {
    return undefined;
  }
  return memberId.startsWith('bot:') ? 'Bot' : 'Someone';
}
