import {
  assistantReportsNoActionableOutput,
  classifyPublicationToolPart,
  decidePublicationRecovery,
  messageInfoReportsAssistantError,
  type PublicationRecoverySignal,
} from '../publication-recovery.js';
import type { GitHubReviewTarget } from '../../../src/shared/github-review-target.js';
import type { ActivityMessage, HarnessActivity } from './harness-activity.js';

export const REVIEW_PUBLICATION_RECOVERY_SUBMIT_TIMEOUT_MS = 15_000;

export function createReviewPublication(input: {
  target?: GitHubReviewTarget;
  submit: (signal: AbortSignal) => Promise<void>;
  abortAndResume: () => void;
  warn: (message: string) => void;
  /** V2 completion must also confirm the recovery submission's response and drain. */
  awaitSubmissionResponse?: boolean;
  scheduler: {
    setTimeout: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  };
}) {
  let state: 'unused' | 'submitted' | 'running' | 'spent' | 'abandoned' = 'unused';
  let signal: PublicationRecoverySignal | null = null;
  let failure: unknown;
  let assistantMessage: { id: string; created?: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  const texts = new Map<string, string>();
  const messages = new Map<string, { role: ActivityMessage['role']; created?: number }>();

  function clearTimer() {
    if (timer !== undefined) input.scheduler.clearTimeout(timer);
    timer = undefined;
  }

  return {
    /** Turn lifecycle events: `session.turn.open` and `session.turn.close`. */
    observe(type: string) {
      if (state === 'abandoned') return;
      if (type === 'session.turn.open' && state === 'submitted') state = 'running';
      if (type === 'session.turn.close' && state === 'running') {
        state = 'spent';
        if (!input.awaitSubmissionResponse) clearTimer();
      }
    },
    observeActivity(activity: HarnessActivity) {
      if (state === 'abandoned') return;
      if (activity.type === 'message') {
        const message = activity.message;
        const created = messages.get(message.id)?.created ?? message.time?.created;
        messages.set(message.id, { role: message.role, created });
        if (messages.size > 128) {
          const oldest = messages.keys().next();
          if (!oldest.done) messages.delete(oldest.value);
        }
        if (message.role === 'assistant') {
          if (message.id !== assistantMessage?.id) {
            if (
              created !== undefined &&
              assistantMessage?.created !== undefined &&
              created < assistantMessage.created
            ) {
              return;
            }
            assistantMessage = { id: message.id, created };
            texts.clear();
            failure = undefined;
          } else if (assistantMessage.created === undefined) {
            assistantMessage.created = created;
          }
          if (messageInfoReportsAssistantError(message)) failure = message.error;
        }
        return;
      }
      const messageId = activity.type === 'part' ? activity.part.messageId : activity.messageId;
      if (messages.get(messageId)?.role !== 'assistant') return;
      if (signal?.kind !== 'verified' && activity.type === 'part' && activity.part.tool) {
        const result = classifyPublicationToolPart(activity.part.tool);
        if (result) signal = result;
      }
      if (messageId !== assistantMessage?.id) return;
      if (activity.type === 'delta') {
        texts.set(
          activity.partId,
          `${texts.get(activity.partId) ?? ''}${activity.text}`.slice(-8192)
        );
      } else {
        const part = activity.part;
        if (part.kind === 'text' && part.text !== undefined)
          texts.set(part.id, part.text.slice(-8192));
      }
      if (texts.size > 32) texts.delete(texts.keys().next().value ?? '');
      if (
        assistantReportsNoActionableOutput(
          [...texts.values()].map(text => ({ type: 'text', text }))
        )
      )
        failure = { name: 'MessageOutputLengthError' };
    },
    recover(): boolean {
      if (state === 'submitted' || state === 'running') return true;
      if (
        decidePublicationRecovery({
          configured: input.target !== undefined,
          turnFailed: failure !== undefined,
          signal,
          budgetUsed: state === 'spent' || state === 'abandoned',
        }) === 'seal'
      )
        return false;
      state = 'submitted';
      timer = input.scheduler.setTimeout(() => {
        state = 'abandoned';
        abort.abort(new Error('Review publication recovery submission timed out'));
        input.warn('Review publication recovery submission timed out');
        input.abortAndResume();
      }, REVIEW_PUBLICATION_RECOVERY_SUBMIT_TIMEOUT_MS);
      void input
        .submit(abort.signal)
        .then(clearTimer)
        .catch(() => {
          if (abort.signal.aborted) return;
          state = 'abandoned';
          clearTimer();
          input.warn('Review publication recovery submission failed');
          input.abortAndResume();
        });
      return true;
    },
    dispose() {
      if (input.awaitSubmissionResponse) state = 'abandoned';
      clearTimer();
      abort.abort();
    },
    failure: () => failure,
  };
}
