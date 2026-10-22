import type { ChatEvent } from './normalizer';
import { replaySnapshotPage, replayStoredMessages } from './snapshot-page';
import type { MessageInfo, Part, SessionSnapshot, SessionSnapshotPage, ToolPart } from './types';

function storedMessage(id: string): SessionSnapshot['messages'][number] {
  return {
    info: { id, sessionID: 'ses-1', role: 'assistant' } as MessageInfo,
    parts: [],
  };
}

function textPart(id: string, messageID: string): Part {
  return { id, sessionID: 'ses-1', messageID, type: 'text', text: 'hello' } as Part;
}

function settledToolPart(id: string, messageID: string, end: number): ToolPart {
  return {
    id,
    sessionID: 'ses-1',
    messageID,
    type: 'tool',
    tool: 'bash',
    state: { status: 'completed', input: {}, output: 'done', time: { start: 1, end } },
  } as ToolPart;
}

describe('replayStoredMessages', () => {
  it('emits each message row before its parts, in page order', () => {
    const first = storedMessage('msg-1');
    first.parts = [textPart('part-1a', 'msg-1'), textPart('part-1b', 'msg-1')];
    const second = storedMessage('msg-2');
    second.parts = [textPart('part-2a', 'msg-2')];

    const events: ChatEvent[] = [];
    replayStoredMessages([first, second], event => events.push(event));

    expect(events.map(event => event.type)).toEqual([
      'message.updated',
      'message.part.updated',
      'message.part.updated',
      'message.updated',
      'message.part.updated',
    ]);
    expect(events[0]).toEqual({ type: 'message.updated', info: first.info });
    expect(events[1]).toEqual({ type: 'message.part.updated', part: first.parts[0]! });
    expect(events[4]).toEqual({ type: 'message.part.updated', part: second.parts[0]! });
  });

  it('carries the settle time of a completed tool part and omits it otherwise', () => {
    const message = storedMessage('msg-1');
    const toolPart = settledToolPart('part-tool', 'msg-1', 7);
    message.parts = [textPart('part-text', 'msg-1'), toolPart];

    const events: ChatEvent[] = [];
    replayStoredMessages([message], event => events.push(event));

    expect(events[1]).toEqual({
      type: 'message.part.updated',
      part: textPart('part-text', 'msg-1'),
    });
    expect(events[1]).not.toHaveProperty('time');
    expect(events[2]).toEqual({ type: 'message.part.updated', part: toolPart, time: 7 });
  });

  it('emits nothing for an empty page', () => {
    const events: ChatEvent[] = [];
    replayStoredMessages([], event => events.push(event));
    expect(events).toEqual([]);
  });
});

describe('replaySnapshotPage', () => {
  it('announces the session before the messages it carries', () => {
    const page: SessionSnapshotPage = {
      info: { id: 'ses-1' } as SessionSnapshotPage['info'],
      messages: [storedMessage('msg-1')],
      nextCursor: null,
      omittedItemCount: 0,
    };
    const order: string[] = [];

    replaySnapshotPage(
      {
        onChatEvent: event => order.push(event.type),
        onServiceEvent: event => order.push(event.type),
      },
      page
    );

    expect(order).toEqual(['session.created', 'message.updated']);
  });
});
