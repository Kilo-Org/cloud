import { type MessageDeliveryState, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { useCallback, useMemo, useRef, useState } from 'react';

import { type ChatComposerControl } from '@/components/agents/chat-composer';
import { type ChatState } from '@/lib/chat/state';
import { askedMessageId } from '@/lib/chat/turns';

/** What a bubble of a chat is handed: its details, and for the unanswered question, its recovery. */
type BubbleActions = {
  onLongPressDetails: (message: StoredMessage) => void;
  deliveryState?: MessageDeliveryState;
  onRetryMessage?: () => void;
  onCopyToComposer?: (text: string) => void;
};

/**
 * What a person can do from a message of a chat.
 *
 * A long-press opens the details of any message, as it does in a session. The
 * question that has no answer carries the session's failure footer: Retry, and
 * Copy to composer to edit the question first. A chat asks only that last
 * question again, so no other message offers a Retry.
 *
 * That question is found by its identifier rather than by being last: what was
 * typed while its answer failed waits under it.
 */
export function useChatMessageActions(
  state: Pick<ChatState, 'sessionId' | 'status' | 'asked' | 'failureKey'>,
  messages: readonly StoredMessage[],
  retry: () => Promise<void>
) {
  const composerControlRef = useRef<ChatComposerControl | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const unanswered =
    state.status === 'idle' && state.asked !== null ? askedMessageId(state.sessionId) : undefined;
  // A question whose answer failed says so, and the row under the transcript
  // says why. A question with no failure was stopped.
  const stopped = state.failureKey === null;
  const delivery = useMemo<MessageDeliveryState>(
    () => ({ status: 'failed', error: '', reason: stopped ? 'interrupted' : 'execution' }),
    [stopped]
  );

  const openDetails = useCallback((message: StoredMessage) => {
    setDetailsId(message.info.id);
  }, []);
  const closeDetails = useCallback(() => {
    setDetailsId(null);
  }, []);
  const copyToComposer = useCallback((text: string) => {
    composerControlRef.current?.setText(text);
  }, []);

  const actionsFor = useCallback(
    (message: StoredMessage): BubbleActions =>
      message.info.id === unanswered
        ? {
            onLongPressDetails: openDetails,
            deliveryState: delivery,
            onRetryMessage: () => {
              void retry();
            },
            onCopyToComposer: copyToComposer,
          }
        : { onLongPressDetails: openDetails },
    [copyToComposer, delivery, openDetails, retry, unanswered]
  );

  // A message can leave the transcript while its details are open: a model
  // switch copies every turn under a new identifier. The sheet then closes.
  const shown = messages.find(message => message.info.id === detailsId) ?? null;
  return {
    composerControlRef,
    hasUnanswered: unanswered !== undefined,
    actionsFor,
    details: {
      visible: shown !== null,
      message: shown,
      ...(shown !== null && shown.info.id === unanswered ? { deliveryState: delivery } : {}),
      onClose: closeDetails,
    },
  };
}
