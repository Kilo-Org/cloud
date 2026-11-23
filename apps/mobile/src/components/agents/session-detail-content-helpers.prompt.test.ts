import { describe, expect, it } from 'vitest';

import { type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { newestConfirmedPromptSentAt } from './session-detail-content-helpers';
import { assistantMessage, userMessage } from './message-bubble-test-utils';

/** The assistant row that answers `parentID`, as server data links them. */
function withParent(message: StoredMessage, parentID: string): StoredMessage {
  if (message.info.role !== 'assistant') {
    return message;
  }
  return { ...message, info: { ...message.info, parentID } };
}

const ROW_TIME = 1_761_000_000_000;

function userRow(id: string, texts: readonly string[], created = ROW_TIME): StoredMessage {
  const message = userMessage(id);
  message.info = { ...message.info, time: { created } };
  message.parts = texts.map((text, index) => ({
    id: `${id}-text-${index}`,
    sessionID: 'ses_1',
    messageID: id,
    type: 'text',
    text,
  })) as typeof message.parts;
  return message;
}

function assistantRow(id: string, text: string): StoredMessage {
  const message = withParent(assistantMessage(id), 'm-user');
  message.parts = [
    {
      id: `${id}-text`,
      sessionID: 'ses_1',
      messageID: id,
      type: 'text',
      text,
    },
  ] as typeof message.parts;
  return message;
}

function syntheticUserRow(id: string, text: string): StoredMessage {
  const row = userRow(id, [text]);
  if (row.info.role !== 'user') {
    throw new Error('the fixture row must be a user row');
  }
  row.info = { ...row.info, synthetic: true };
  return row;
}

describe('newestConfirmedPromptSentAt', () => {
  it('answers the row time when the confirmed row carrying the text ends the transcript', () => {
    expect(newestConfirmedPromptSentAt([userRow('m1', ['Retry me'])], 'Retry me')).toBe(ROW_TIME);
  });

  it('answers the newest row’s own time, not the fixture default', () => {
    const row = userRow('m-dated', ['continue'], ROW_TIME + 5_000);
    expect(newestConfirmedPromptSentAt([row], 'continue')).toBe(ROW_TIME + 5_000);
  });

  it('is null for a synthetic user row, which the server has not confirmed', () => {
    expect(newestConfirmedPromptSentAt([syntheticUserRow('m-ghost', 'Retry me')], 'Retry me')).toBe(
      null
    );
  });

  it('is null when an answer follows the confirmed row', () => {
    // The turn was answered, so this text is an earlier prompt the reader may
    // be repeating on purpose rather than the send whose draft is restored.
    const prompt = userRow('m-answered', ['continue']);
    const answer = assistantRow('m-answer', 'Answered');
    expect(newestConfirmedPromptSentAt([prompt, answer], 'continue')).toBe(null);
  });

  it('is null when a later user row follows the confirmed row', () => {
    const prompt = userRow('m-answered', ['continue']);
    const later = userRow('m-later', ['and then this']);
    expect(newestConfirmedPromptSentAt([prompt, later], 'continue')).toBe(null);
  });

  it('ignores synthetic trailing rows, which are not answers', () => {
    // A synthetic row is the client's own submission of the next send, not a
    // recorded answer, so the delivered prompt still ends the transcript.
    const prompt = userRow('m-last-confirmed', ['continue']);
    const pending = syntheticUserRow('m-pending', 'next');
    expect(newestConfirmedPromptSentAt([prompt, pending], 'continue')).toBe(ROW_TIME);
  });

  it('is null for an assistant row carrying the same text', () => {
    expect(newestConfirmedPromptSentAt([assistantRow('m-assistant', 'Retry me')], 'Retry me')).toBe(
      null
    );
  });

  it('is null for a different text', () => {
    expect(newestConfirmedPromptSentAt([userRow('m2', ['Something else'])], 'Retry me')).toBe(null);
  });

  it('ignores an older turn that carried the same words', () => {
    // Only the newest confirmed row can be the delivery which just landed; the
    // reader may be repeating a short prompt like this on purpose.
    const older = userRow('m-older', ['continue']);
    const newest = userRow('m-newest', ['something else']);
    expect(newestConfirmedPromptSentAt([older, newest], 'continue')).toBe(null);
  });

  it('matches a draft kept with surrounding whitespace against the sent prompt', () => {
    expect(newestConfirmedPromptSentAt([userRow('m1', ['continue'])], '  continue  ')).toBe(
      ROW_TIME
    );
  });

  it('is null for a draft with nothing visible to send', () => {
    expect(newestConfirmedPromptSentAt([userRow('m1', ['continue'])], '   ')).toBe(null);
  });

  it('compares the first human text part, as the composer restores it', () => {
    const row = userRow('m3', ['Retry me', 'and then this']);
    expect(newestConfirmedPromptSentAt([row], 'Retry me')).toBe(ROW_TIME);
    expect(newestConfirmedPromptSentAt([row], 'and then this')).toBe(null);
  });
});
