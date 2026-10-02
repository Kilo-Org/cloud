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
  /** True when the composer resolved a cannot-send reason to state. */
  hasSendReason: boolean;
  messageCount: number;
};

/**
 * Which single item the fixed footer row above the composer shows, in priority
 * order: the working spinner, the SDK status indicator, then the cannot-send
 * reason.
 */
export type SessionFooterRowItem = 'working' | 'status' | 'reason';

/**
 * Padding shared by every item of the fixed footer row. The row swaps items
 * mid-stream with no layout transition, so equal padding keeps the swap
 * height-neutral: a taller item would resize the flex-1 transcript above it.
 */
export const SESSION_FOOTER_ROW_ITEM_PADDING = 'px-4 py-2';

/**
 * Largest OS font scale the cannot-send reason grows to. It is the one row item
 * whose copy length the catalog does not bound, so it carries a cap that the
 * single-line row can absorb.
 */
export const SEND_REASON_MAX_FONT_SCALE = 1.6;

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
 * The fixed footer row above the composer shows ONE item, so its height does not
 * change with the item: the working spinner wins, then the SDK status
 * indicator, then the cannot-send reason.
 *
 * Two transcript surfaces already state progress, so neither takes a progress
 * item here. An empty transcript renders its own centered indicator, and a live
 * PreparationGroup shows the current preparation attempt. Stale
 * completed/failed groups must not suppress the row — otherwise a recycle
 * re-prepare can leave a blank progress window until the new running attempt
 * merges. The reason states a send gate no transcript surface carries, so it
 * outlives both suppressions — including the failed load on an empty
 * transcript, where it is the reader's only line.
 */
export function resolveSessionFooterRowItem({
  cloudStatusType,
  hasInProgressTranscriptPreparation,
  shouldShowFooterWorking,
  hasStatusIndicator,
  hasSendReason,
  messageCount,
}: SessionFooterRowInput): SessionFooterRowItem | null {
  const transcriptOwnsProgress =
    messageCount === 0 || (cloudStatusType === 'preparing' && hasInProgressTranscriptPreparation);
  if (!transcriptOwnsProgress) {
    if (shouldShowFooterWorking) {
      return 'working';
    }
    if (hasStatusIndicator) {
      return 'status';
    }
  }
  return hasSendReason ? 'reason' : null;
}
