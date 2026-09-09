const TERMINAL_REVIEW_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

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

/**
 * Same gates as apps/web `getCodeReviewDisplayBehavior`. Org reviews run as
 * bot-owned sessions, so a stream ticket is creator-only (web #5781). In-flight
 * org transcripts must poll `getSessionMessages` instead of opening a socket.
 */
export function getCodeReviewDisplayBehavior(
  snapshot: CodeReviewStreamSnapshot
): CodeReviewDisplayBehavior {
  const isHistorical = snapshot.agentVersion !== 'v2';
  const isTerminal = TERMINAL_REVIEW_STATUSES.has(snapshot.status);
  const shouldPollStatus = !isHistorical && !isTerminal;
  const shouldPollMessages = shouldPollStatus && Boolean(snapshot.organizationId);

  return {
    isHistorical,
    isTerminal,
    shouldLoadMessages: isHistorical || isTerminal || shouldPollMessages,
    shouldPollMessages,
    shouldPollStatus,
  };
}

/** Keep the last non-empty poll so an empty ingest snapshot cannot blank the log. */
export function retainPolledSpectatorRows<T>(
  latest: readonly T[],
  retained: readonly T[],
  shouldPoll: boolean
): readonly T[] {
  if (shouldPoll && latest.length === 0 && retained.length > 0) {
    return retained;
  }
  return latest;
}

type StreamInfo = {
  agentVersion: string;
  status: string;
  organizationId?: string;
  cloudAgentSessionId: string | null;
};

export function reviewSpectatorStreamInfoInterval(
  data: ({ success?: boolean } & Partial<StreamInfo>) | undefined
): number | false {
  if (!data?.success || data.agentVersion === undefined || data.status === undefined) {
    return 2000;
  }
  return getCodeReviewDisplayBehavior({
    agentVersion: data.agentVersion,
    status: data.status,
    organizationId: data.organizationId,
  }).shouldPollStatus
    ? 2000
    : false;
}

type ReviewSpectatorMode = {
  isTerminal: boolean;
  shouldPollMessages: boolean;
  shouldLoadHistory: boolean;
  liveCloudId: string | null;
};

export function resolveReviewSpectatorMode(
  info: StreamInfo | null,
  parentStatus: string,
  liveRowCount: number
): ReviewSpectatorMode {
  const parentIsTerminal = TERMINAL_REVIEW_STATUSES.has(parentStatus);
  if (info === null) {
    return {
      isTerminal: parentIsTerminal,
      shouldPollMessages: false,
      shouldLoadHistory: false,
      liveCloudId: null,
    };
  }
  const displayBehavior = getCodeReviewDisplayBehavior({
    agentVersion: info.agentVersion,
    status: parentIsTerminal ? parentStatus : info.status,
    organizationId: info.organizationId,
  });
  return {
    isTerminal: displayBehavior.isTerminal,
    shouldPollMessages: displayBehavior.shouldPollMessages,
    shouldLoadHistory: displayBehavior.shouldLoadMessages && liveRowCount === 0,
    liveCloudId:
      displayBehavior.shouldLoadMessages || info.cloudAgentSessionId === null
        ? null
        : info.cloudAgentSessionId,
  };
}
