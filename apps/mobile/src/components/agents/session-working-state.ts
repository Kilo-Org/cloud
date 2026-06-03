type AgentWorkingIndicatorInput = {
  isStreaming: boolean;
  pendingMessageCount: number;
};

type FooterWorkingIndicatorInput = {
  isAgentWorking: boolean;
  hasStatusIndicator: boolean;
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
