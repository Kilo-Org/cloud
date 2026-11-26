import type { ChannelOutcome, EmailMessage, NoticeTransports, PushMessage } from './transports';

/**
 * Transports that send nothing: they record each message and answer the outcome `answer` picks.
 * The development entry (src/dev.ts) and the tests use them; no deployed entry reaches this module.
 */

export type RecordedMessage =
  | { channel: 'push'; outcome: ChannelOutcome; message: PushMessage }
  | { channel: 'email'; outcome: ChannelOutcome; message: EmailMessage };

export type FakeAnswers = {
  push: (message: PushMessage) => ChannelOutcome;
  email: (message: EmailMessage) => ChannelOutcome;
};

export const ALWAYS_SENT: FakeAnswers = { push: () => 'sent', email: () => 'sent' };

export function fakeTransports(answers: FakeAnswers, outbox: RecordedMessage[]): NoticeTransports {
  return {
    push: async message => {
      const outcome = answers.push(message);
      outbox.push({ channel: 'push', outcome, message });
      return outcome;
    },
    email: async message => {
      const outcome = answers.email(message);
      outbox.push({ channel: 'email', outcome, message });
      return outcome;
    },
  };
}
