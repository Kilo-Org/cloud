const TERMINAL_REVIEW_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

type CodeReviewStreamSnapshot = {
  agentVersion: string;
  status: string;
  cloudAgentSessionId: string | null;
};

type CodeReviewDisplayBehavior = {
  isHistorical: boolean;
  isTerminal: boolean;
  shouldLoadHistory: boolean;
  shouldPollStatus: boolean;
};

export function getCodeReviewDisplayBehavior(
  snapshot: CodeReviewStreamSnapshot
): CodeReviewDisplayBehavior {
  const isHistorical = snapshot.agentVersion !== 'v2';
  const isTerminal = TERMINAL_REVIEW_STATUSES.has(snapshot.status);

  return {
    isHistorical,
    isTerminal,
    shouldLoadHistory: isHistorical || isTerminal,
    shouldPollStatus: !isHistorical && !isTerminal && !snapshot.cloudAgentSessionId,
  };
}
