import { describe, expect, it } from 'vitest';
import { restoreCanceledQueuedMessages } from './session-detail-content-helpers';
import { mergeSessionTranscript } from './session-transcript';
import { assistantMessage, userMessage } from './message-bubble-test-utils';

describe('restoreCanceledQueuedMessages', () => {
  it('keeps parent-before-reply order when it restores a canceled queued row', () => {
    const prompt = userMessage('z-prompt');
    const reply = assistantMessage('a-reply');
    const continuation = assistantMessage('b-continuation');
    reply.parts = userMessage(reply.info.id).parts;
    continuation.parts = userMessage(continuation.info.id).parts;
    const queued = userMessage('y-queued');
    const messages = [prompt, reply, continuation];
    const merged = restoreCanceledQueuedMessages(messages, new Map([[queued.info.id, queued]]));
    expect(merged.filter(message => message !== queued)).toEqual(messages);
    expect(
      mergeSessionTranscript(merged, [])
        .filter(item => item.type === 'message')
        .map(item => item.message.info.id)
    ).toEqual(['y-queued', 'z-prompt', 'a-reply', 'b-continuation']);
    expect(messages).toEqual([prompt, reply, continuation]);
  });

  it('restores an available parent before a reply that arrived after cancellation', () => {
    const prompt = userMessage('z-prompt');
    const reply = assistantMessage('a-reply');
    if (reply.info.role !== 'assistant') {
      throw new Error('expected assistant fixture');
    }
    reply.info.parentID = prompt.info.id;
    reply.info.sessionID = prompt.info.sessionID;
    expect(
      restoreCanceledQueuedMessages([reply], new Map([[prompt.info.id, prompt]])).map(
        message => message.info.id
      )
    ).toEqual(['z-prompt', 'a-reply']);
  });

  it('does not duplicate a canonical queued row or allocate when nothing needs restoring', () => {
    const prompt = userMessage('a-prompt');
    const messages = [prompt];
    expect(restoreCanceledQueuedMessages(messages, new Map([[prompt.info.id, prompt]]))).toBe(
      messages
    );
  });

  it('preserves the ID order of canceled rows and an already ordered transcript', () => {
    const first = userMessage('b-queued');
    const second = userMessage('d-queued');
    const messages = [userMessage('a-prompt'), assistantMessage('c-reply')];
    expect(
      restoreCanceledQueuedMessages(
        messages,
        new Map([
          [second.info.id, second],
          [first.info.id, first],
        ])
      ).map(message => message.info.id)
    ).toEqual(['a-prompt', 'b-queued', 'c-reply', 'd-queued']);
  });
});
