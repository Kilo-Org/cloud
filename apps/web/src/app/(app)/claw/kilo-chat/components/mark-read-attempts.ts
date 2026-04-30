type LastMarkedRef = {
  current: string | null;
};

export function shouldAttemptMarkRead(
  lastMarkedConversationId: string | null,
  conversationId: string
): boolean {
  return lastMarkedConversationId !== conversationId;
}

export function rememberMarkReadAttempt(lastMarkedRef: LastMarkedRef, conversationId: string) {
  lastMarkedRef.current = conversationId;
}

export function releaseFailedMarkReadAttempt(lastMarkedRef: LastMarkedRef, conversationId: string) {
  if (lastMarkedRef.current === conversationId) {
    lastMarkedRef.current = null;
  }
}
