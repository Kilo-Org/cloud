import { describe, expect, it } from 'vitest';

import { type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { hasConfirmedSentPrompt } from './session-detail-content-helpers';
import { assistantMessage, userMessage } from './message-bubble-test-utils';

/** The assistant row that answers `parentID`, as server data links them. */
function withParent(message: StoredMessage, parentID: string): StoredMessage {
  if (message.info.role !== 'assistant') {
    return message;
  }
  return { ...message, info: { ...message.info, parentID } };
}

function userRow(id: string, texts: readonly string[]): StoredMessage {
  const message = userMessage(id);
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

describe('hasConfirmedSentPrompt', () => {
  it('is true for a confirmed user row carrying the same text', () => {
    expect(hasConfirmedSentPrompt([userRow('m1', ['Retry me'])], 'Retry me')).toBe(true);
  });

  it('is false for a synthetic user row, which the server has not confirmed', () => {
    const row = userRow('m-ghost', ['Retry me']);
    if (row.info.role !== 'user') {
      throw new Error('the fixture row must be a user row');
    }
    row.info = { ...row.info, synthetic: true };
    expect(hasConfirmedSentPrompt([row], 'Retry me')).toBe(false);
  });

  it('is false for an assistant row carrying the same text', () => {
    expect(hasConfirmedSentPrompt([assistantRow('m-assistant', 'Retry me')], 'Retry me')).toBe(
      false
    );
  });

  it('is false for a different text', () => {
    expect(hasConfirmedSentPrompt([userRow('m2', ['Something else'])], 'Retry me')).toBe(false);
  });

  it('ignores an older turn that carried the same words', () => {
    // Only the newest confirmed row can be the delivery which just landed; the
    // reader may be repeating a short prompt like this on purpose.
    const older = userRow('m-older', ['continue']);
    const newest = userRow('m-newest', ['something else']);
    expect(hasConfirmedSentPrompt([older, newest], 'continue')).toBe(false);
  });

  it('matches a draft kept with surrounding whitespace against the sent prompt', () => {
    expect(hasConfirmedSentPrompt([userRow('m1', ['continue'])], '  continue  ')).toBe(true);
  });

  it('is false for a draft with nothing visible to send', () => {
    expect(hasConfirmedSentPrompt([userRow('m1', ['continue'])], '   ')).toBe(false);
  });

  it('compares the first human text part, as the composer restores it', () => {
    const row = userRow('m3', ['Retry me', 'and then this']);
    expect(hasConfirmedSentPrompt([row], 'Retry me')).toBe(true);
    expect(hasConfirmedSentPrompt([row], 'and then this')).toBe(false);
  });
});
