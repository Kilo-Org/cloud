import type { SessionStatusIndicator as SessionStatusIndicatorType } from '@kilocode/cloud-agent-sdk';
import { cn } from '@/lib/utils';
import { SessionStatusIndicator } from './SessionStatusIndicator';
import { WorkingIndicator } from './WorkingIndicator';
import type { StoredMessage } from './types';

/**
 * A fixed slot under the transcript, so status changes do not move it. A
 * running preparation row sits in this exact place, so the slot yields its
 * height to it.
 */
export function TranscriptStatusSlot({
  yieldToPreparationRow,
  workingMessages,
  indicator,
}: {
  yieldToPreparationRow: boolean;
  /** The messages of the turn in progress, while the working indicator shows. */
  workingMessages: StoredMessage[] | null;
  indicator: SessionStatusIndicatorType | null;
}) {
  return (
    <div
      className={cn('overflow-hidden', yieldToPreparationRow ? 'h-0' : 'h-8')}
      role="status"
      aria-live="polite"
    >
      {workingMessages ? (
        <WorkingIndicator messages={workingMessages} isStreaming />
      ) : (
        indicator && <SessionStatusIndicator indicator={indicator} />
      )}
    </div>
  );
}
