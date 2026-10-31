import { describe, expect, it } from 'vitest';

import { liveTextParts, type CursorEvent } from '../../e2e/workspace-history.js';

function delta(input: {
  partID: string;
  messageID?: string;
  sessionID?: string;
  text: string;
  eventId: number;
  cursor?: number;
}): CursorEvent {
  return {
    eventId: input.eventId,
    sessionId: 'workspace_1',
    streamEventType: 'kilocode',
    timestamp: new Date(0).toISOString(),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    data: {
      type: 'message.part.delta',
      event: 'message.part.delta',
      properties: {
        sessionID: input.sessionID ?? 'ses_1',
        messageID: input.messageID ?? 'msg_assistant',
        partID: input.partID,
        field: 'text',
        delta: input.text,
      },
    },
  } as unknown as CursorEvent;
}

function updated(input: {
  partID: string;
  messageID?: string;
  sessionID?: string;
  text: string;
  eventId: number;
  cursor?: number;
}): CursorEvent {
  return {
    eventId: input.eventId,
    sessionId: 'workspace_1',
    streamEventType: 'kilocode',
    timestamp: new Date(0).toISOString(),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    data: {
      type: 'message.part.updated',
      event: 'message.part.updated',
      properties: {
        part: {
          id: input.partID,
          sessionID: input.sessionID ?? 'ses_1',
          messageID: input.messageID ?? 'msg_assistant',
          type: 'text',
          text: input.text,
        },
      },
    },
  } as unknown as CursorEvent;
}

describe('liveTextParts', () => {
  it('accumulates raw message.part.delta frames under one stable persisted row id', () => {
    const parts = liveTextParts([
      delta({ partID: 'part_1', text: ' w0 ', eventId: 7, cursor: 3 }),
      delta({ partID: 'part_1', text: ' w1 ', eventId: 7, cursor: 5 }),
    ]);
    expect(parts.size).toBe(1);
    const part = parts.get('part_1');
    expect(part).toMatchObject({
      id: 'part_1',
      messageID: 'msg_assistant',
      sessionID: 'ses_1',
      text: ' w0  w1 ',
      eventId: 7,
      cursor: 5,
    });
  });

  it('treats message.part.updated as authoritative but keeps known text on an empty update', () => {
    const parts = liveTextParts([
      delta({ partID: 'part_1', text: ' w0 ', eventId: 7, cursor: 3 }),
      updated({ partID: 'part_1', text: ' w0  w1 ', eventId: 7, cursor: 4 }),
      updated({ partID: 'part_1', text: '', eventId: 7, cursor: 6 }),
    ]);
    expect(parts.get('part_1')).toMatchObject({
      text: ' w0  w1 ',
      eventId: 7,
      cursor: 6,
    });
  });

  it('keeps separate parts apart and ignores frames that are not kilocode text parts', () => {
    const parts = liveTextParts([
      delta({ partID: 'part_1', text: 'a', eventId: 1, cursor: 1 }),
      delta({ partID: 'part_2', text: 'b', eventId: 2, cursor: 2 }),
      {
        eventId: 3,
        sessionId: 'workspace_1',
        streamEventType: 'cloud.message.queued',
        timestamp: new Date(0).toISOString(),
        data: { messageId: 'msg_user' },
      } as unknown as CursorEvent,
    ]);
    expect([...parts.keys()].sort()).toEqual(['part_1', 'part_2']);
    expect(parts.get('part_1')?.text).toBe('a');
    expect(parts.get('part_2')?.text).toBe('b');
  });
});
