import { describe, expect, it } from 'vitest';

import {
  hasUnprojectedPrivateStructuredPath,
  projectPublicEvent,
  projectPublicStoredMessage,
} from './public-sdk-projection';

const kiloSessionId = 'ses_12345678901234567890123456';
const foreignKiloSessionId = 'ses_22222222222222222222222222';

describe('projectPublicEvent', () => {
  it('suppresses message.updated when embedded message identity conflicts with the exposed root', () => {
    expect(
      projectPublicEvent(
        {
          type: 'message.updated',
          properties: {
            sessionID: kiloSessionId,
            info: {
              id: 'msg_foreign',
              sessionID: foreignKiloSessionId,
              role: 'assistant',
            },
          },
        },
        kiloSessionId
      )
    ).toBeNull();
  });

  it('suppresses message.part.updated when embedded part identity conflicts with the exposed root', () => {
    expect(
      projectPublicEvent(
        {
          type: 'message.part.updated',
          properties: {
            sessionID: kiloSessionId,
            part: {
              id: 'prt_foreign',
              sessionID: foreignKiloSessionId,
              messageID: 'msg_foreign',
              type: 'text',
              text: 'private foreign part',
            },
          },
        },
        kiloSessionId
      )
    ).toBeNull();
  });

  it('suppresses message.part.updated when a nested tool attachment identity conflicts with the exposed root', () => {
    expect(
      projectPublicEvent(
        {
          type: 'message.part.updated',
          properties: {
            sessionID: kiloSessionId,
            part: {
              id: 'prt_tool',
              sessionID: kiloSessionId,
              messageID: 'msg_tool',
              type: 'tool',
              state: {
                status: 'completed',
                attachments: [
                  {
                    id: 'prt_foreign_attachment',
                    sessionID: foreignKiloSessionId,
                    messageID: 'msg_tool',
                    type: 'file',
                    mime: 'text/plain',
                    url: 'data:text/plain,safe',
                  },
                ],
              },
            },
          },
        },
        kiloSessionId
      )
    ).toBeNull();
  });

  it('suppresses session.updated when a top-level session identity conflicts with the exposed root', () => {
    expect(
      projectPublicEvent(
        {
          type: 'session.updated',
          properties: {
            sessionID: foreignKiloSessionId,
            info: { id: kiloSessionId },
          },
        },
        kiloSessionId
      )
    ).toBeNull();
  });

  it('suppresses unreviewed event variants when their top-level identity conflicts with the exposed root', () => {
    expect(
      projectPublicEvent(
        {
          type: 'todo.updated',
          properties: { sessionID: foreignKiloSessionId, todos: [] },
        },
        kiloSessionId
      )
    ).toBeNull();
  });

  it('preserves root message and part events with matching embedded identities', () => {
    expect(
      projectPublicEvent(
        {
          type: 'message.updated',
          properties: {
            sessionID: kiloSessionId,
            info: { id: 'msg_root', sessionID: kiloSessionId, role: 'assistant' },
          },
        },
        kiloSessionId
      )
    ).toEqual({
      type: 'message.updated',
      properties: {
        sessionID: kiloSessionId,
        info: { id: 'msg_root', sessionID: kiloSessionId, role: 'assistant' },
      },
    });
    expect(
      projectPublicEvent(
        {
          type: 'message.part.updated',
          properties: {
            sessionID: kiloSessionId,
            part: {
              id: 'prt_root',
              sessionID: kiloSessionId,
              messageID: 'msg_root',
              type: 'text',
              text: 'public root part',
            },
          },
        },
        kiloSessionId
      )
    ).toEqual({
      type: 'message.part.updated',
      properties: {
        sessionID: kiloSessionId,
        part: {
          id: 'prt_root',
          sessionID: kiloSessionId,
          messageID: 'msg_root',
          type: 'text',
          text: 'public root part',
        },
      },
    });
  });

  it.each(['file.edited', 'pty.exited', 'indexing.status', 'session.error'])(
    'suppresses identityless %s variants fail-closed',
    type => {
      expect(projectPublicEvent({ type, properties: {} }, kiloSessionId)).toBeNull();
    }
  );

  it('suppresses identityless message.updated variants fail-closed', () => {
    expect(
      projectPublicEvent(
        { type: 'message.updated', properties: { info: { id: 'msg_identityless' } } },
        kiloSessionId
      )
    ).toBeNull();
  });

  it('does not trust arbitrary nested matching session identities for attribution', () => {
    expect(
      projectPublicEvent(
        {
          type: 'todo.updated',
          properties: { metadata: { sessionID: kiloSessionId }, todos: [] },
        },
        kiloSessionId
      )
    ).toBeNull();
  });

  it('does not treat arbitrary nested foreign session identities as authoritative', () => {
    expect(
      projectPublicEvent(
        {
          type: 'todo.updated',
          properties: {
            sessionID: kiloSessionId,
            metadata: { sessionID: foreignKiloSessionId },
            todos: [],
          },
        },
        kiloSessionId
      )
    ).toEqual({
      type: 'todo.updated',
      properties: {
        sessionID: kiloSessionId,
        metadata: { sessionID: foreignKiloSessionId },
        todos: [],
      },
    });
  });

  it('does not treat tool input or structured output session identities as authoritative', () => {
    const event = {
      type: 'message.part.updated',
      properties: {
        sessionID: kiloSessionId,
        part: {
          id: 'prt_tool_data',
          sessionID: kiloSessionId,
          messageID: 'msg_tool_data',
          type: 'tool',
          state: {
            status: 'completed',
            input: { sessionID: foreignKiloSessionId },
            output: { sessionID: foreignKiloSessionId },
            metadata: { sessionID: foreignKiloSessionId },
          },
        },
      },
    };
    expect(projectPublicEvent(event, kiloSessionId)).toEqual(event);
  });

  it('suppresses explicit child session.idle variants', () => {
    expect(
      projectPublicEvent(
        { type: 'session.idle', properties: { sessionID: foreignKiloSessionId } },
        kiloSessionId
      )
    ).toBeNull();
  });
});

describe('projectPublicEvent file URLs', () => {
  it('redacts wrapper-local file URLs from loose event file parts and completed tool attachments', () => {
    expect(
      projectPublicEvent(
        {
          type: 'message.part.updated',
          properties: {
            sessionID: kiloSessionId,
            part: {
              id: 'prt_event_file',
              sessionID: kiloSessionId,
              messageID: 'msg_event_file',
              type: 'file',
              mime: 'text/plain',
              url: 'file:///workspace/private/event.txt',
            },
          },
        },
        kiloSessionId
      )
    ).toMatchObject({ properties: { part: { url: '' } } });
    expect(
      projectPublicEvent(
        {
          type: 'message.part.updated',
          properties: {
            sessionID: kiloSessionId,
            part: {
              id: 'prt_event_tool',
              sessionID: kiloSessionId,
              messageID: 'msg_event_tool',
              type: 'tool',
              state: {
                status: 'completed',
                attachments: [
                  {
                    id: 'prt_event_attachment',
                    sessionID: kiloSessionId,
                    messageID: 'msg_event_tool',
                    type: 'file',
                    mime: 'text/plain',
                    url: 'file:///workspace/private/attachment.txt',
                  },
                  {
                    id: 'prt_event_data_attachment',
                    sessionID: kiloSessionId,
                    messageID: 'msg_event_tool',
                    type: 'file',
                    mime: 'text/plain',
                    url: 'data:text/plain,safe',
                  },
                ],
              },
            },
          },
        },
        kiloSessionId
      )
    ).toMatchObject({
      properties: {
        part: { state: { attachments: [{ url: '' }, { url: 'data:text/plain,safe' }] } },
      },
    });
  });

  it('fails closed when private local file URIs remain outside reviewed redaction paths', () => {
    expect(
      projectPublicEvent(
        {
          type: 'message.part.updated',
          properties: {
            sessionID: kiloSessionId,
            part: {
              id: 'prt_resource',
              sessionID: kiloSessionId,
              messageID: 'msg_resource',
              type: 'file',
              mime: 'text/plain',
              url: 'data:text/plain,safe',
              source: {
                type: 'resource',
                uri: 'file:///workspace/private/resource.txt',
              },
            },
          },
        },
        kiloSessionId
      )
    ).toBeNull();
    expect(
      projectPublicEvent(
        {
          type: 'todo.updated',
          properties: {
            sessionID: kiloSessionId,
            artifact: { href: 'FILE:///workspace/private/unreviewed.txt' },
          },
        },
        kiloSessionId
      )
    ).toBeNull();
  });
});

describe('projectPublicStoredMessage', () => {
  it('redacts wrapper-local file URLs from typed stored file parts while preserving data URLs', () => {
    const projected = projectPublicStoredMessage(
      {
        info: {
          id: 'msg_files',
          sessionID: kiloSessionId,
          role: 'user',
          time: { created: 100 },
          agent: 'build',
          model: { providerID: 'test', modelID: 'fake' },
        },
        parts: [
          {
            id: 'prt_local_file',
            sessionID: kiloSessionId,
            messageID: 'msg_files',
            type: 'file',
            mime: 'text/plain',
            url: 'file:///workspace/private/secret.txt',
          },
          {
            id: 'prt_data_file',
            sessionID: kiloSessionId,
            messageID: 'msg_files',
            type: 'file',
            mime: 'text/plain',
            url: 'data:text/plain,safe',
          },
          {
            id: 'prt_tool',
            sessionID: kiloSessionId,
            messageID: 'msg_files',
            type: 'tool',
            callID: 'call_files',
            tool: 'read',
            state: {
              status: 'completed',
              input: {},
              output: 'safe',
              title: 'read',
              metadata: {},
              time: { start: 100, end: 101 },
              attachments: [
                {
                  id: 'prt_local_attachment',
                  sessionID: kiloSessionId,
                  messageID: 'msg_files',
                  type: 'file',
                  mime: 'text/plain',
                  url: 'file:///workspace/private/attachment.txt',
                },
              ],
            },
          },
        ],
      },
      kiloSessionId
    );

    expect(projected.parts).toMatchObject([
      { url: '' },
      { url: 'data:text/plain,safe' },
      { state: { attachments: [{ url: '' }] } },
    ]);
  });

  it('exposes typed resource file URIs to the final fail-closed boundary check', () => {
    const projected = projectPublicStoredMessage(
      {
        info: {
          id: 'msg_resource',
          sessionID: kiloSessionId,
          role: 'user',
          time: { created: 100 },
          agent: 'build',
          model: { providerID: 'test', modelID: 'fake' },
        },
        parts: [
          {
            id: 'prt_resource',
            sessionID: kiloSessionId,
            messageID: 'msg_resource',
            type: 'file',
            mime: 'text/plain',
            url: 'data:text/plain,safe',
            source: {
              type: 'resource',
              text: { value: 'private', start: 0, end: 7 },
              clientName: 'wrapper',
              uri: 'file:///workspace/private/resource.txt',
            },
          },
        ],
      },
      kiloSessionId
    );

    expect(hasUnprojectedPrivateStructuredPath(projected)).toBe(true);
  });
});
