/* eslint-disable jest/no-hooks, max-lines, sort-keys -- beforeEach clears the shared image store; fixture literals mirror SDK field order */
import { beforeEach, describe, expect, it } from 'vitest';
import type { AssistantMessage, StoredMessage, UserMessage } from '@kilocode/cloud-agent-sdk';
import { clearToolImages, rememberToolImage } from '@/src/shared/agent-tool-images';
import {
  getStreamingTextPartId,
  isMessageStreaming,
  toAgentConversationItems,
} from './agents-conversation-adapter';

const userInfo = (id: string, overrides: Partial<UserMessage> = {}): UserMessage => ({
  agent: '',
  id,
  model: { modelID: 'test', providerID: 'kilo' },
  role: 'user',
  sessionID: 'ses-1',
  time: { created: 1000 },
  ...overrides,
});

const assistantInfo = (
  id: string,
  overrides: Partial<AssistantMessage> = {}
): AssistantMessage => ({
  agent: '',
  cost: 0,
  id,
  modelID: 'test',
  mode: 'code',
  parentID: 'msg-parent',
  path: { cwd: '/', root: '/' },
  providerID: 'kilo',
  role: 'assistant',
  sessionID: 'ses-1',
  time: { created: 2000 },
  tokens: { cache: { read: 0, write: 0 }, input: 0, output: 0, reasoning: 0 },
  ...overrides,
});

describe('agent conversation mapping', () => {
  beforeEach(() => {
    clearToolImages();
  });

  it('drops the synthetic snapshot progress part', () => {
    const messages: StoredMessage[] = [
      {
        info: assistantInfo('msg-snap'),
        parts: [
          {
            id: 'p-snap',
            messageID: 'msg-snap',
            sessionID: 'ses-1',
            synthetic: true,
            text: '⠋ Initializing snapshot…',
            type: 'text' as const,
          },
        ],
      },
    ];
    expect(toAgentConversationItems(messages)).toStrictEqual([]);
  });

  it('keeps a synthetic user text part that is not snapshot progress', () => {
    const messages: StoredMessage[] = [
      {
        info: userInfo('msg-queued'),
        parts: [
          {
            id: 'p-queued',
            messageID: 'msg-queued',
            sessionID: 'ses-1',
            synthetic: true,
            text: 'queued message',
            type: 'text' as const,
          },
        ],
      },
    ];
    expect(toAgentConversationItems(messages)).toStrictEqual([
      {
        event: { id: 'p-queued', role: 'user', text: 'queued message', type: 'message' },
        type: 'event',
      },
    ]);
  });

  it('drops a blank text part', () => {
    const messages: StoredMessage[] = [
      {
        info: userInfo('msg-blank'),
        parts: [
          {
            id: 'p-blank',
            messageID: 'msg-blank',
            sessionID: 'ses-1',
            text: '   ',
            type: 'text' as const,
          },
        ],
      },
    ];
    expect(toAgentConversationItems(messages)).toStrictEqual([]);
  });

  it('drops a blank reasoning part', () => {
    const messages: StoredMessage[] = [
      {
        info: assistantInfo('msg-blank-think'),
        parts: [
          {
            id: 'p-blank-think',
            messageID: 'msg-blank-think',
            sessionID: 'ses-1',
            text: ' \n ',
            time: { start: 2000 },
            type: 'reasoning' as const,
          },
        ],
      },
    ];
    expect(toAgentConversationItems(messages)).toStrictEqual([]);
  });

  it('maps a non-blank reasoning part to a thinking event', () => {
    const messages: StoredMessage[] = [
      {
        info: assistantInfo('msg-think'),
        parts: [
          {
            id: 'p-think',
            messageID: 'msg-think',
            sessionID: 'ses-1',
            text: 'Let me think',
            time: { start: 2000 },
            type: 'reasoning' as const,
          },
        ],
      },
    ];
    expect(toAgentConversationItems(messages)).toStrictEqual([
      { event: { id: 'p-think', text: 'Let me think', type: 'thinking' }, type: 'event' },
    ]);
  });

  it('maps text, reasoning, and tool parts in stored order', () => {
    const messages: StoredMessage[] = [
      {
        info: assistantInfo('msg-order'),
        parts: [
          {
            id: 'p-tool',
            callID: 'call-order',
            messageID: 'msg-order',
            sessionID: 'ses-1',
            state: {
              input: {},
              metadata: {},
              output: 'done',
              status: 'completed' as const,
              time: { end: 2100, start: 2000 },
              title: 'read',
            },
            tool: 'read',
            type: 'tool' as const,
          },
          {
            id: 'p-think',
            messageID: 'msg-order',
            sessionID: 'ses-1',
            text: 'thinking',
            time: { start: 2000 },
            type: 'reasoning' as const,
          },
          {
            id: 'p-text',
            messageID: 'msg-order',
            sessionID: 'ses-1',
            text: 'result text',
            type: 'text' as const,
          },
        ],
      },
    ];
    const items = toAgentConversationItems(messages);
    expect(items[0]?.type).toBe('tool-exchange');
    expect(items[1]).toStrictEqual({
      event: { id: 'p-think', text: 'thinking', type: 'thinking' },
      type: 'event',
    });
    expect(items[2]).toStrictEqual({
      event: { id: 'p-text', role: 'assistant', text: 'result text', type: 'message' },
      type: 'event',
    });
  });

  it('drops a step-start part', () => {
    const messages: StoredMessage[] = [
      {
        info: assistantInfo('msg-step'),
        parts: [
          {
            id: 'p-step',
            messageID: 'msg-step',
            sessionID: 'ses-1',
            type: 'step-start' as const,
          },
        ],
      },
    ];
    expect(toAgentConversationItems(messages)).toStrictEqual([]);
  });

  it('maps a running tool to a tool-exchange with no result', () => {
    const messages: StoredMessage[] = [
      {
        info: assistantInfo('msg-running'),
        parts: [
          {
            id: 'p-running',
            callID: 'call-running',
            messageID: 'msg-running',
            sessionID: 'ses-1',
            state: {
              input: { filePath: 'src/a.ts' },
              status: 'running' as const,
              time: { start: 2000 },
            },
            tool: 'read',
            type: 'tool' as const,
          },
        ],
      },
    ];
    const items = toAgentConversationItems(messages);
    expect(items).toHaveLength(1);
    expect(items[0]).toStrictEqual({
      toolCall: {
        arguments: { filePath: 'src/a.ts' },
        id: 'p-running',
        name: 'read',
        source: 'agent',
        type: 'tool-call',
      },
      type: 'tool-exchange',
    });
    expect('result' in items[0]!).toBe(false);
  });

  it('maps a completed tool with its title and output', () => {
    const messages: StoredMessage[] = [
      {
        info: assistantInfo('msg-completed'),
        parts: [
          {
            id: 'p-completed',
            callID: 'call-completed',
            messageID: 'msg-completed',
            sessionID: 'ses-1',
            state: {
              input: { filePath: 'src/a.ts' },
              metadata: {},
              output: 'file contents',
              status: 'completed' as const,
              time: { end: 2100, start: 2000 },
              title: 'src/a.ts',
            },
            tool: 'read',
            type: 'tool' as const,
          },
        ],
      },
    ];
    expect(toAgentConversationItems(messages)).toStrictEqual([
      {
        result: {
          id: 'p-completed-result',
          ok: true,
          toolCallId: 'p-completed',
          type: 'tool-result',
          value: 'file contents',
        },
        toolCall: {
          arguments: { filePath: 'src/a.ts' },
          id: 'p-completed',
          name: 'read',
          source: 'agent',
          title: 'src/a.ts',
          type: 'tool-call',
        },
        type: 'tool-exchange',
      },
    ]);
  });

  it('maps an errored tool to a failed exchange with the error text', () => {
    const messages: StoredMessage[] = [
      {
        info: assistantInfo('msg-error'),
        parts: [
          {
            id: 'p-error',
            callID: 'call-error',
            messageID: 'msg-error',
            sessionID: 'ses-1',
            state: {
              error: 'command not found',
              input: {},
              status: 'error' as const,
              time: { end: 2100, start: 2000 },
            },
            tool: 'bash',
            type: 'tool' as const,
          },
        ],
      },
    ];
    expect(toAgentConversationItems(messages)).toStrictEqual([
      {
        result: {
          error: 'command not found',
          id: 'p-error-result',
          ok: false,
          toolCallId: 'p-error',
          type: 'tool-result',
        },
        toolCall: {
          arguments: {},
          id: 'p-error',
          name: 'bash',
          source: 'agent',
          type: 'tool-call',
        },
        type: 'tool-exchange',
      },
    ]);
  });

  it('adds imageDataUrl for a completed tool with a remembered image', () => {
    rememberToolImage('p-shot', {
      dataUrl: 'data:image/png;base64,AAAA',
      mime: 'image/png',
    });
    const messages: StoredMessage[] = [
      {
        info: assistantInfo('msg-shot'),
        parts: [
          {
            id: 'p-shot',
            callID: 'call-shot',
            messageID: 'msg-shot',
            sessionID: 'ses-1',
            state: {
              input: { fullPage: false },
              metadata: {},
              output: 'captured',
              status: 'completed' as const,
              time: { end: 2100, start: 2000 },
              title: 'viewport',
            },
            tool: 'browser_screenshot',
            type: 'tool' as const,
          },
        ],
      },
    ];
    const items = toAgentConversationItems(messages);
    expect(items[0]).toMatchObject({
      result: {
        imageDataUrl: 'data:image/png;base64,AAAA',
        ok: true,
        toolCallId: 'p-shot',
        type: 'tool-result',
        value: 'captured',
      },
    });
  });
});

describe('streaming text part id', () => {
  it('returns the last text part id of the streaming assistant tail', () => {
    const messages: StoredMessage[] = [
      {
        info: userInfo('msg-user'),
        parts: [
          {
            id: 'p-user',
            messageID: 'msg-user',
            sessionID: 'ses-1',
            text: 'hello',
            type: 'text' as const,
          },
        ],
      },
      {
        info: assistantInfo('msg-stream'),
        parts: [
          {
            id: 'p-think',
            messageID: 'msg-stream',
            sessionID: 'ses-1',
            text: 'thinking',
            type: 'text' as const,
          },
          {
            id: 'p-tail',
            messageID: 'msg-stream',
            sessionID: 'ses-1',
            text: 'final',
            type: 'text' as const,
          },
        ],
      },
    ];
    expect(getStreamingTextPartId(messages)).toBe('p-tail');
  });

  it('returns undefined on a completed transcript', () => {
    const messages: StoredMessage[] = [
      {
        info: assistantInfo('msg-done', {
          time: { completed: 2100, created: 2000 },
        }),
        parts: [
          {
            id: 'p-done',
            messageID: 'msg-done',
            sessionID: 'ses-1',
            text: 'done',
            type: 'text' as const,
          },
        ],
      },
    ];
    expect(getStreamingTextPartId(messages)).toBeUndefined();
  });

  it('returns undefined for an errored assistant message with no completed time', () => {
    const messages: StoredMessage[] = [
      {
        info: assistantInfo('msg-errored', {
          error: { data: { isRetryable: false, message: 'boom' }, name: 'APIError' },
        }),
        parts: [
          {
            id: 'p-errored',
            messageID: 'msg-errored',
            sessionID: 'ses-1',
            text: 'partial',
            type: 'text' as const,
          },
        ],
      },
    ];
    expect(getStreamingTextPartId(messages)).toBeUndefined();
    expect(isMessageStreaming(messages[0]!)).toBe(false);
  });
});
