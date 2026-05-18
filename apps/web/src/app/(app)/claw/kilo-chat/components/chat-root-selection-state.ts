export type ChatRootLandingDecision = 'wait' | 'stay' | 'open-latest' | 'create-empty-conversation';

export const CHAT_ROOT_AUTO_OPEN_SUPPRESSION_PARAM = 'suppressAutoOpen';

export function getSuppressedChatRootPath(basePath: string): string {
  return `${basePath}?${CHAT_ROOT_AUTO_OPEN_SUPPRESSION_PARAM}=1`;
}

export function shouldStartRootEmptyConversationCreate({
  hasAttemptedEmptyConversationCreate,
  isCreatePending,
  landingDecision,
  sandboxId,
}: {
  hasAttemptedEmptyConversationCreate: boolean;
  isCreatePending: boolean;
  landingDecision: ChatRootLandingDecision;
  sandboxId: string | null;
}): boolean {
  return (
    landingDecision === 'create-empty-conversation' &&
    sandboxId !== null &&
    !isCreatePending &&
    !hasAttemptedEmptyConversationCreate
  );
}

export function shouldIgnoreRootEmptyConversationCreateResult({
  activeConversationId,
  currentSandboxId,
  hasResolvedRootLanding,
  isAutoOpenSuppressed,
  mutationSandboxId,
}: {
  activeConversationId: string | null;
  currentSandboxId: string | null;
  hasResolvedRootLanding: boolean;
  isAutoOpenSuppressed: boolean;
  mutationSandboxId: string;
}): boolean {
  return (
    currentSandboxId !== mutationSandboxId ||
    activeConversationId !== null ||
    isAutoOpenSuppressed ||
    hasResolvedRootLanding
  );
}

export function getChatRootLandingDecision({
  activeConversationId,
  hasConversationHistoryData,
  hasConversationHistoryError,
  hasResolvedRootLanding,
  isAutoOpenSuppressed,
  isFetchingConversationHistory,
  isLoading,
  latestConversationId,
  sandboxId,
}: {
  activeConversationId: string | null;
  hasConversationHistoryData: boolean;
  hasConversationHistoryError: boolean;
  hasResolvedRootLanding: boolean;
  isAutoOpenSuppressed: boolean;
  isFetchingConversationHistory: boolean;
  isLoading: boolean;
  latestConversationId: string | null;
  sandboxId: string | null;
}): ChatRootLandingDecision {
  if (activeConversationId !== null || hasResolvedRootLanding || isAutoOpenSuppressed) {
    return 'stay';
  }
  if (
    hasConversationHistoryError ||
    isFetchingConversationHistory ||
    isLoading ||
    sandboxId === null ||
    !hasConversationHistoryData
  ) {
    return 'wait';
  }
  return latestConversationId === null ? 'create-empty-conversation' : 'open-latest';
}
