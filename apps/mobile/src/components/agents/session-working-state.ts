type AgentWorkingIndicatorInput = {
  isStreaming: boolean;
  pendingMessageCount: number;
};

type FooterWorkingIndicatorInput = {
  isAgentWorking: boolean;
  hasStatusIndicator: boolean;
};

type SessionFooterRowInput = {
  cloudStatusType: string | null | undefined;
  /** True only when the transcript shows a live (running) PreparationGroup. */
  hasInProgressTranscriptPreparation: boolean;
  shouldShowFooterWorking: boolean;
  hasStatusIndicator: boolean;
  messageCount: number;
};

export function shouldShowAgentWorkingIndicator({
  isStreaming,
  pendingMessageCount,
}: AgentWorkingIndicatorInput): boolean {
  return isStreaming || pendingMessageCount > 0;
}

export function shouldShowFooterWorkingIndicator({
  isAgentWorking,
  hasStatusIndicator,
}: FooterWorkingIndicatorInput): boolean {
  return isAgentWorking && !hasStatusIndicator;
}

/**
 * Fixed footer row above the composer (working spinner and/or cloud status).
 * While cloud-agent preparation is in flight AND the transcript already shows
 * a live PreparationGroup, hide the footer so progress is not duplicated.
 * Stale completed/failed groups must not suppress the footer — otherwise a
 * recycle re-prepare can leave a blank progress window until the new running
 * attempt merges. Zero-message empty state is handled elsewhere.
 */
export function shouldShowSessionFooterRow({
  cloudStatusType,
  hasInProgressTranscriptPreparation,
  shouldShowFooterWorking,
  hasStatusIndicator,
  messageCount,
}: SessionFooterRowInput): boolean {
  if (messageCount === 0) {
    return false;
  }
  if (cloudStatusType === 'preparing' && hasInProgressTranscriptPreparation) {
    return false;
  }
  return shouldShowFooterWorking || hasStatusIndicator;
}
