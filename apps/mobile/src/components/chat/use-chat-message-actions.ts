import { type MessageDeliveryState, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { useCallback, useMemo, useRef, useState } from 'react';

import { type ChatComposerControl } from '@/components/agents/chat-composer';
import { type ChatState, type Displaced } from '@/lib/chat/state';
import { askedMessageId, displacedMessageId } from '@/lib/chat/turns';

/**
 * The bubble the slot's question is drawn as: its own, or the kept one it asks
 * again, which is drawn at the place it was said.
 */
function slotBubbleId(
  state: Pick<ChatState, 'sessionId' | 'status' | 'asked' | 'askedFrom'>
): string | undefined {
  if (state.status !== 'idle' || state.asked === null) {
    return undefined;
  }
  return state.askedFrom === null
    ? askedMessageId(state.sessionId)
    : displacedMessageId(state.sessionId, state.askedFrom);
}

/** What a bubble of a chat is handed: its details, and for an unanswered question, its recovery. */
type BubbleActions = {
  onLongPressDetails: (message: StoredMessage) => void;
  deliveryState?: MessageDeliveryState;
  onRetryMessage?: () => void;
  onCopyToComposer?: (text: string) => void;
};

/**
 * What a person can do from a message of a chat.
 *
 * A long-press opens the details of any message, as it does in a session. Every
 * question that has no answer carries the session's failure footer: Retry, and
 * Copy to composer to edit the question first. That is the question in the slot
 * and every one a later send kept, so a failure a newer question pushed out of
 * the slot keeps the recovery it had there. A chat asks only that last question
 * again, so no other message offers a Retry.
 *
 * The slot's question is found by its identifier rather than by being last: what
 * was typed while its answer failed waits under it. A question asked again is
 * one bubble at the place it was said, so the slot's identifier is that bubble
 * when it names a kept question.
 */
export function useChatMessageActions(
  state: Pick<
    ChatState,
    'sessionId' | 'status' | 'asked' | 'askedFrom' | 'displaced' | 'failureKey'
  >,
  messages: readonly StoredMessage[],
  retry: (displaced?: Displaced) => Promise<void>
) {
  const composerControlRef = useRef<ChatComposerControl | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const unanswered = slotBubbleId(state);
  // A question whose answer failed says so, and the row under the transcript
  // says why. A question with no failure was stopped.
  const stopped = state.failureKey === null;
  const delivery = useMemo<MessageDeliveryState>(
    () => ({ status: 'failed', error: '', reason: stopped ? 'interrupted' : 'execution' }),
    [stopped]
  );
  /* Each kept question with how it ended, by the identifier its bubble carries.
     A failed answer says the response failed; a question the person stopped
     reads as interrupted, as the slot's own question does while it holds it. */
  const kept = useMemo(
    () =>
      new Map(
        state.displaced.map(question => [
          displacedMessageId(state.sessionId, question.id),
          {
            question,
            delivery: {
              status: 'failed' as const,
              error: '',
              reason:
                question.outcome === 'failed' ? ('execution' as const) : ('interrupted' as const),
            },
          },
        ])
      ),
    [state.displaced, state.sessionId]
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

  const asking = state.askedFrom;
  const actionsFor = useCallback(
    (message: StoredMessage): BubbleActions => {
      if (message.info.id === unanswered) {
        return {
          onLongPressDetails: openDetails,
          deliveryState: delivery,
          onRetryMessage: () => {
            void retry();
          },
          onCopyToComposer: copyToComposer,
        };
      }
      const earlier = kept.get(message.info.id);
      /* The kept question the slot is asking again carries no recovery while it
         is being asked: it is the attempt on screen, not a failure under it. */
      if (earlier !== undefined && earlier.question.id !== asking) {
        return {
          onLongPressDetails: openDetails,
          deliveryState: earlier.delivery,
          onRetryMessage: () => {
            void retry(earlier.question);
          },
          onCopyToComposer: copyToComposer,
        };
      }
      return { onLongPressDetails: openDetails };
    },
    [asking, copyToComposer, delivery, kept, openDetails, retry, unanswered]
  );

  // A message can leave the transcript while its details are open: a model
  // switch copies every turn under a new identifier, and a kept question is
  // asked again. The sheet then closes.
  const shown = messages.find(message => message.info.id === detailsId) ?? null;
  const shownSlot = shown !== null && shown.info.id === unanswered ? delivery : undefined;
  const shownKept = shown === null || shownSlot !== undefined ? undefined : kept.get(shown.info.id);
  const detailsDelivery = shownSlot ?? shownKept?.delivery;
  return {
    composerControlRef,
    hasUnanswered: unanswered !== undefined,
    actionsFor,
    details: {
      visible: shown !== null,
      message: shown,
      ...(detailsDelivery === undefined ? {} : { deliveryState: detailsDelivery }),
      onClose: closeDetails,
    },
  };
}
