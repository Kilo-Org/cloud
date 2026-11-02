import { type MessageDeliveryState, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { useCallback, useMemo, useRef, useState } from 'react';

import { type ChatComposerControl } from '@/components/agents/chat-composer';
import { type ChatState, type Displaced } from '@/lib/chat/state';
import { askedMessageId, displacedMessageId } from '@/lib/chat/turns';

/**
 * The bubble the slot's question is drawn as: its own, or the kept one it asks
 * again, which is drawn at the place it was said. A slot that names a kept
 * question the transcript no longer holds falls back to its own bubble, which is
 * where the transcript builder drew it.
 */
function slotBubbleId(
  state: Pick<ChatState, 'sessionId' | 'status' | 'asked' | 'askedFrom' | 'displaced'>
): string | undefined {
  if (state.status !== 'idle' || state.asked === null) {
    return undefined;
  }
  const from = state.askedFrom;
  if (from === null || !state.displaced.some(one => one.id === from)) {
    return askedMessageId(state.sessionId);
  }
  return displacedMessageId(state.sessionId, from);
}

/**
 * The kept questions that are on their way to being asked: the one in the slot,
 * and the ones waiting in the line. Their bubbles carry no recovery while they
 * are the attempt rather than a failure under it.
 */
function onTheirWay(state: Pick<ChatState, 'askedFrom' | 'waiting'>): ReadonlySet<string> {
  return new Set([
    ...(state.askedFrom === null ? [] : [state.askedFrom]),
    ...state.waiting.flatMap(one => (one.from == null ? [] : [one.from])),
  ]);
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
    'sessionId' | 'status' | 'asked' | 'askedFrom' | 'displaced' | 'waiting' | 'failureKey'
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

  /* Rebuilt only when the line or the slot changes: every word of an answer is
     a publish, and a new set per render would recreate every row's actions. */
  const askedFrom = state.askedFrom;
  const waiting = state.waiting;
  const asking = useMemo(() => onTheirWay({ askedFrom, waiting }), [askedFrom, waiting]);
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
      if (earlier !== undefined && !asking.has(earlier.question.id)) {
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
