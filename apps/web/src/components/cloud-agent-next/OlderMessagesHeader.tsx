'use client';

import type { OlderMessagesError } from '@kilocode/cloud-agent-sdk';
import { Button } from '@/components/ui/button';
import { selectOlderMessagesHeaderState } from './older-messages-scroll';

type OlderMessagesHeaderProps = {
  isLoadingOlderMessages: boolean;
  olderMessagesError: OlderMessagesError | null;
  olderMessagesOmittedItemCount: number;
  onRetry: () => void;
};

function omittedMessage(count: number): string {
  if (count === 1) {
    return 'Some earlier items from this session could not be displayed.';
  }
  return `${count} earlier items from this session could not be displayed.`;
}

export function OlderMessagesHeader({
  isLoadingOlderMessages,
  olderMessagesError,
  olderMessagesOmittedItemCount,
  onRetry,
}: OlderMessagesHeaderProps) {
  const state = selectOlderMessagesHeaderState({
    isLoadingOlderMessages,
    olderMessagesError,
    olderMessagesOmittedItemCount,
  });

  if (state.kind === 'hidden') {
    return null;
  }

  if (state.kind === 'retryable') {
    return (
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">Couldn't load earlier messages.</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="min-h-11 shrink-0"
        >
          Retry
        </Button>
      </div>
    );
  }

  const text =
    state.kind === 'invalid_data'
      ? "Earlier messages aren't available."
      : state.kind === 'too_large'
        ? 'Earlier messages are too large to load.'
        : omittedMessage(state.count);

  return <p className="text-muted-foreground mb-3 text-sm">{text}</p>;
}
