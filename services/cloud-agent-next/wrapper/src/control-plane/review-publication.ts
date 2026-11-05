import {
  assistantReportsNoActionableOutput,
  classifyPublicationToolPart,
  decidePublicationRecovery,
  messageInfoReportsAssistantError,
  type PublicationRecoverySignal,
} from '../publication-recovery.js';
import type { GitHubReviewTarget } from '../../../src/shared/github-review-target.js';
import type { HarnessActivity } from './harness-activity.js';

export const REVIEW_PUBLICATION_RECOVERY_SUBMIT_TIMEOUT_MS = 15_000;

export function createReviewPublication(input: {
  target?: GitHubReviewTarget;
  submit: (signal: AbortSignal) => Promise<void>;
  abortAndResume: () => void;
  warn: (message: string) => void;
  scheduler: {
    setTimeout: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  };
}) {
  let state: 'unused' | 'submitted' | 'running' | 'spent' | 'abandoned' = 'unused';
  let signal: PublicationRecoverySignal | null = null;
  let failure: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  const texts = new Map<string, string>();
  const roles = new Map<string, string>();

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
        clearTimer();
      }
    },
    observeActivity(activity: HarnessActivity) {
      if (state === 'abandoned') return;
      if (activity.type === 'message') {
        const message = activity.message;
        roles.set(message.id, message.role);
        if (roles.size > 128) roles.delete(roles.keys().next().value ?? '');
        if (message.role === 'assistant' && messageInfoReportsAssistantError(message))
          failure = message.error;
        return;
      }
      const messageId = activity.type === 'part' ? activity.part.messageId : activity.messageId;
      if (roles.get(messageId) !== 'assistant') return;
      if (activity.type === 'delta') {
        texts.set(
          activity.partId,
          `${texts.get(activity.partId) ?? ''}${activity.text}`.slice(-8192)
        );
      } else {
        const part = activity.part;
        const result = part.tool ? classifyPublicationToolPart(part.tool) : null;
        if (result) signal = result;
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
      clearTimer();
      abort.abort();
    },
    failure: () => failure,
  };
}
