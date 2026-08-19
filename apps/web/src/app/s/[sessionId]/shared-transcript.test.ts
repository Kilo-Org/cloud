import type { Part, StoredMessage, ToolPart } from '@/components/cloud-agent-next/types';
import {
  groupAssistantParts,
  summarizeAgentWork,
  toSharedTranscriptMessages,
} from './shared-transcript';

function makeTextPart(id: string, text: string): Part {
  return {
    id,
    sessionID: 'ses_1',
    messageID: 'msg_1',
    type: 'text',
    text,
  };
}

function makeReasoningPart(id: string, text: string, durationMs = 4000): Part {
  return {
    id,
    sessionID: 'ses_1',
    messageID: 'msg_1',
    type: 'reasoning',
    text,
    time: { start: 1, end: 1 + durationMs },
  };
}

function makeToolPart(id: string, tool: string, durationMs = 2000): ToolPart {
  return {
    id,
    sessionID: 'ses_1',
    messageID: 'msg_1',
    type: 'tool',
    callID: `call_${id}`,
    tool,
    state: {
      status: 'completed',
      input: { filePath: 'src/app.ts' },
      output: 'ok',
      title: tool,
      metadata: {},
      time: { start: 10, end: 10 + durationMs },
    },
  };
}

function makeStepStart(id: string): Part {
  return {
    id,
    sessionID: 'ses_1',
    messageID: 'msg_1',
    type: 'step-start',
  };
}

describe('toSharedTranscriptMessages', () => {
  it('keeps user and assistant messages that have a created timestamp', () => {
    const messages = [
      {
        info: { id: 'user_1', role: 'user', time: { created: 1 } },
        parts: [{ id: 'p1' }],
      },
      {
        info: { id: 'assistant_1', role: 'assistant', time: { created: 2 } },
        parts: [{ id: 'p2' }],
      },
    ];

    expect(toSharedTranscriptMessages(messages)).toHaveLength(2);
  });

  it('drops messages without a role or created timestamp', () => {
    const messages = [
      { info: { id: 'no_role' }, parts: [{ id: 'p1' }] },
      { info: { id: 'system', role: 'system', time: { created: 1 } }, parts: [{ id: 'p2' }] },
      { info: { id: 'no_time', role: 'user' }, parts: [{ id: 'p3' }] },
    ];

    expect(toSharedTranscriptMessages(messages)).toEqual([]);
  });
});

describe('groupAssistantParts', () => {
  it('collapses consecutive agent-work parts around chat text', () => {
    const segments = groupAssistantParts([
      makeReasoningPart('r1', 'thinking'),
      makeToolPart('t1', 'read'),
      makeStepStart('s1'),
      makeTextPart('txt1', 'Here is the result.'),
      makeToolPart('t2', 'edit'),
    ]);

    expect(segments).toEqual([
      {
        type: 'agent-work',
        parts: [expect.objectContaining({ id: 'r1' }), expect.objectContaining({ id: 't1' })],
        summary: expect.stringContaining('1 tool call'),
      },
      {
        type: 'chat',
        parts: [expect.objectContaining({ id: 'txt1' })],
      },
      {
        type: 'agent-work',
        parts: [expect.objectContaining({ id: 't2' })],
        summary: expect.stringContaining('1 tool call'),
      },
    ]);
  });

  it('hides empty reasoning and internal plan tools', () => {
    const planTool: ToolPart = {
      ...makeToolPart('plan', 'plan_enter'),
      tool: 'plan_enter',
    };
    const segments = groupAssistantParts([
      makeReasoningPart('empty', '   '),
      planTool,
      makeTextPart('txt1', 'Done.'),
    ]);

    expect(segments).toEqual([
      {
        type: 'chat',
        parts: [expect.objectContaining({ id: 'txt1' })],
      },
    ]);
  });
});

describe('summarizeAgentWork', () => {
  it('prefers a worked duration and tool count', () => {
    expect(
      summarizeAgentWork([makeToolPart('t1', 'read', 1500), makeToolPart('t2', 'edit', 2500)])
    ).toBe('Worked for 4s · 2 tool calls');
  });

  it('falls back to Agent work when there is nothing to summarize', () => {
    expect(summarizeAgentWork([])).toBe('Agent work');
  });
});

describe('shared transcript message shape', () => {
  it('preserves StoredMessage identity for the renderer', () => {
    const message: StoredMessage = {
      info: {
        id: 'msg_1',
        sessionID: 'ses_1',
        role: 'user',
        time: { created: 1 },
        agent: 'build',
        model: { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-4' },
      },
      parts: [makeTextPart('p1', 'hello')],
    };

    expect(toSharedTranscriptMessages([message])).toEqual([message]);
  });
});
