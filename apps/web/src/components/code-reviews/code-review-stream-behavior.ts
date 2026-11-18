const TERMINAL_REVIEW_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

type CodeReviewStreamSnapshot = {
  agentVersion: string;
  status: string;
  organizationId?: string;
};

type CodeReviewDisplayBehavior = {
  isHistorical: boolean;
  isTerminal: boolean;
  shouldLoadMessages: boolean;
  shouldPollMessages: boolean;
  shouldPollStatus: boolean;
};

export function getCodeReviewDisplayBehavior(
  snapshot: CodeReviewStreamSnapshot
): CodeReviewDisplayBehavior {
  const isHistorical = snapshot.agentVersion !== 'v2';
  const isTerminal = TERMINAL_REVIEW_STATUSES.has(snapshot.status);
  const shouldPollStatus = !isHistorical && !isTerminal;
  const shouldPollMessages = shouldPollStatus && !!snapshot.organizationId;

  return {
    isHistorical,
    isTerminal,
    shouldLoadMessages: isHistorical || isTerminal || shouldPollMessages,
    shouldPollMessages,
    shouldPollStatus,
  };
}
