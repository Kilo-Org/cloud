import { type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { useCallback, useMemo, useRef, useState } from 'react';

import { type ChatComposerControl } from '@/components/agents/chat-composer';
import {
  CHAT_RESPONSE_DELIVERY_REASON,
  CREDITS_DELIVERY_REASON,
  type MessageDeliveryStatement,
} from '@/components/agents/message-failure-state';
import { CREDITS_FAILURE_KEY } from '@/lib/chat/backend-target';
import { type AddCreditsDestination } from '@/lib/credits/add-credits-destination';
import { type ChatState, type Displaced } from '@/lib/chat/state';
import { askedMessageId, displacedMessageId, stoppedAnswerMessageId } from '@/lib/chat/turns';

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
 * The bubble a question's recovery hangs off: the words its stopped answer had
 * reached when there are any, so the stop is stated under what it stopped and
 * not between the question and its words, and the question itself otherwise.
 */
const recoveryHost = (questionId: string, answer: string | null | undefined): string =>
  answer == null ? questionId : stoppedAnswerMessageId(questionId);

/**
 * What a question's bubble states about an answer that did not come, from the
 * fixed copy key of its failure: null is a question the person stopped. The
 * bubble names the cause itself — a send the balance refused, a lost
 * connection — so the failure is stated once, where it happened. The generic
 * key adds nothing to the bubble's own title, so it brings no second line.
 */
function failureStatement(failureKey: string | null | undefined): MessageDeliveryStatement {
  if (failureKey == null) {
    return { status: 'failed', error: '', reason: 'interrupted' };
  }
  if (failureKey === CREDITS_FAILURE_KEY) {
    return { status: 'failed', error: '', reason: CREDITS_DELIVERY_REASON };
  }
  return {
    status: 'failed',
    error: '',
    reason: CHAT_RESPONSE_DELIVERY_REASON,
    detailKey: failureKey === 'common.somethingWentWrong' ? null : failureKey,
  };
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
  deliveryState?: MessageDeliveryStatement;
  onRetryMessage?: () => void;
  addCredits?: AddCreditsDestination;
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
 * A send the account's balance refused is the exception: the question states
 * that cause and offers Add credits and Copy to composer, and no Retry, because
 * asking again meets the same balance. `addCredits` opens where credit is
 * bought; the words come back through Copy to composer once it is added.
 *
 * The slot's question is found by its identifier rather than by being last: what
 * was typed while its answer failed waits under it. A question asked again is
 * one bubble at the place it was said, so the slot's identifier is that bubble
 * when it names a kept question.
 */
export function useChatMessageActions(
  state: Pick<
    ChatState,
    | 'sessionId'
    | 'status'
    | 'asked'
    | 'askedFrom'
    | 'askedAnswer'
    | 'displaced'
    | 'waiting'
    | 'failureKey'
  >,
  messages: readonly StoredMessage[],
  recovery: {
    readonly retry: (displaced?: Displaced) => Promise<void>;
    readonly addCredits?: AddCreditsDestination;
  }
) {
  const { retry, addCredits } = recovery;
  const composerControlRef = useRef<ChatComposerControl | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const slotQuestion = slotBubbleId(state);
  const unanswered =
    slotQuestion === undefined ? undefined : recoveryHost(slotQuestion, state.askedAnswer);
  // A question whose answer failed states why on its bubble. A question with no
  // failure was stopped, and one the balance refused offers Add credits.
  const credits = state.failureKey === CREDITS_FAILURE_KEY;
  const delivery = useMemo(() => failureStatement(state.failureKey), [state.failureKey]);
  /* Each kept question with how it ended, by the identifier of the bubble its
     recovery hangs off. A question the person stopped reads as interrupted, as
     the slot's own question does while it holds it. The cause it failed with
     travels with it, so a send the balance refused keeps its statement and its
     Add credits where it was said. A question kept before its outcome was
     recorded failed, with no cause to name. */
  const kept = useMemo(
    () =>
      new Map(
        state.displaced.map(question => [
          recoveryHost(displacedMessageId(state.sessionId, question.id), question.answer),
          {
            question,
            refused: question.failureKey === CREDITS_FAILURE_KEY,
            statement: failureStatement(
              question.outcome === 'failed'
                ? (question.failureKey ?? 'common.somethingWentWrong')
                : null
            ),
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
          /* A refused send carries the action that settles it instead of a Retry
             that would meet the same balance. */
          ...(credits
            ? { addCredits }
            : {
                onRetryMessage: () => {
                  void retry();
                },
              }),
          onCopyToComposer: copyToComposer,
        };
      }
      const earlier = kept.get(message.info.id);
      /* The kept question the slot is asking again carries no recovery while it
         is being asked: it is the attempt on screen, not a failure under it. */
      if (earlier !== undefined && !asking.has(earlier.question.id)) {
        return {
          onLongPressDetails: openDetails,
          deliveryState: earlier.statement,
          /* A kept question the balance refused offers the action that settles
             it, as it did in the slot; every other kept question keeps Retry. */
          ...(earlier.refused
            ? { addCredits }
            : {
                onRetryMessage: () => {
                  void retry(earlier.question);
                },
              }),
          onCopyToComposer: copyToComposer,
        };
      }
      return { onLongPressDetails: openDetails };
    },
    [addCredits, asking, copyToComposer, credits, delivery, kept, openDetails, retry, unanswered]
  );

  // A message can leave the transcript while its details are open: a model
  // switch copies every turn under a new identifier, and a kept question is
  // asked again. The sheet then closes.
  const shown = messages.find(message => message.info.id === detailsId) ?? null;
  const shownSlot = shown !== null && shown.info.id === unanswered ? delivery : undefined;
  const shownKept = shown === null || shownSlot !== undefined ? undefined : kept.get(shown.info.id);
  const detailsDelivery = shownSlot ?? shownKept?.statement;
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
