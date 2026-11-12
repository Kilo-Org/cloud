import { toSharedTranscriptMessages } from './shared-session-transcript';

/**
 * A stored user message in the shape the session-ingest snapshot streams. Only
 * the fields the transcript boundary requires are present, so a case fails for
 * the reason it names rather than for an unrelated missing field.
 */
function userMessage(id: string, parts: unknown[]) {
  return {
    info: {
      id,
      sessionID: 'ses_test',
      role: 'user',
      time: { created: 1_700_000_000_000 },
      agent: 'build',
      model: { providerID: 'anthropic', modelID: 'claude' },
    },
    parts,
  };
}

function textPart(messageId: string, id: string, text: string) {
  return { id, sessionID: 'ses_test', messageID: messageId, type: 'text', text };
}

describe('toSharedTranscriptMessages', () => {
  it('keeps a user message and its readable part', () => {
    const messages = toSharedTranscriptMessages([
      userMessage('msg_1', [textPart('msg_1', 'prt_1', 'hello')]),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.info.id).toBe('msg_1');
    expect(messages[0]?.parts).toEqual([textPart('msg_1', 'prt_1', 'hello')]);
  });

  it('drops a message whose role the transcript cannot render', () => {
    const systemMessage = {
      ...userMessage('msg_2', [textPart('msg_2', 'prt_2', 'rules')]),
      info: { ...userMessage('msg_2', []).info, role: 'system' },
    };

    expect(toSharedTranscriptMessages([systemMessage])).toEqual([]);
  });

  it('drops one unreadable part without hiding the rest of the message', () => {
    const messages = toSharedTranscriptMessages([
      userMessage('msg_1', [
        textPart('msg_1', 'prt_1', 'kept'),
        { id: 'prt_2', messageID: 'msg_1', type: 'future-part-kind' },
      ]),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts.map(part => part.id)).toEqual(['prt_1']);
  });

  it('drops an envelope without a parts list instead of failing the transcript', () => {
    expect(toSharedTranscriptMessages([{ info: userMessage('msg_1', []).info }])).toEqual([]);
  });

  it('orders messages by their time-ordered ids, not ingest order', () => {
    const messages = toSharedTranscriptMessages([
      userMessage('msg_3', [textPart('msg_3', 'prt_3', 'third')]),
      userMessage('msg_1', [textPart('msg_1', 'prt_1', 'first')]),
      userMessage('msg_2', [textPart('msg_2', 'prt_2', 'second')]),
    ]);

    expect(messages.map(message => message.info.id)).toEqual(['msg_1', 'msg_2', 'msg_3']);
  });

  it('returns an empty transcript for a session with no messages', () => {
    expect(toSharedTranscriptMessages([])).toEqual([]);
  });
});
