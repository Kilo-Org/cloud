import {
  assistantReportsNoActionableOutput,
  classifyPublicationToolPart,
  decidePublicationRecovery,
  messageInfoReportsAssistantError,
  type PublicationRecoverySignal,
} from '../publication-recovery.js';
import type { GitHubReviewTarget } from '../../../src/shared/github-review-target.js';

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
    observe(type: string, properties: Record<string, unknown>) {
      if (state === 'abandoned') return;
      if (type === 'session.turn.open' && state === 'submitted') state = 'running';
      if (type === 'session.turn.close' && state === 'running') {
        state = 'spent';
        clearTimer();
      }
      const info = properties.info;
      if (
        type === 'message.updated' &&
        typeof info === 'object' &&
        info !== null &&
        'id' in info &&
        typeof info.id === 'string' &&
        'role' in info &&
        typeof info.role === 'string'
      ) {
        roles.set(info.id, info.role);
        if (roles.size > 128) roles.delete(roles.keys().next().value ?? '');
      }
      if (
        type === 'message.updated' &&
        typeof info === 'object' &&
        info !== null &&
        'role' in info &&
        info.role === 'assistant' &&
        messageInfoReportsAssistantError(info)
      ) {
        if (
          typeof properties.info === 'object' &&
          properties.info !== null &&
          'error' in properties.info
        )
          failure = properties.info.error;
      }
      const part = properties.part;
      const messageId =
        typeof part === 'object' && part !== null && 'messageID' in part
          ? part.messageID
          : properties.messageID;
      if (typeof messageId === 'string' && roles.get(messageId) !== 'assistant') return;
      if (
        type === 'message.part.delta' &&
        typeof properties.partID === 'string' &&
        typeof properties.delta === 'string' &&
        (properties.field === 'text' || properties.field === undefined)
      ) {
        texts.set(
          properties.partID,
          `${texts.get(properties.partID) ?? ''}${properties.delta}`.slice(-8192)
        );
      }
      if (type !== 'message.part.updated' && type !== 'message.part.delta') return;
      const result = classifyPublicationToolPart(part);
      if (result) signal = result;
      if (
        typeof part === 'object' &&
        part !== null &&
        'type' in part &&
        part.type === 'text' &&
        'text' in part &&
        typeof part.text === 'string'
      ) {
        const id = 'id' in part && typeof part.id === 'string' ? part.id : '';
        texts.set(id, part.text.slice(-8192));
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
