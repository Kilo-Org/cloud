type AgentWorkingIndicatorInput = {
  isStreaming: boolean;
  pendingMessageCount: number;
};

export function shouldShowAgentWorkingIndicator({
  isStreaming,
  pendingMessageCount,
}: AgentWorkingIndicatorInput): boolean {
  return isStreaming || pendingMessageCount > 0;
}
