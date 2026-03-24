import { describe, it, expect } from 'vitest';
import {
  reconstructConversation,
  formatTranscriptForRedispatch,
  type ConversationTurn,
} from '../../src/util/reconstruct-conversation.util';
import { type RigAgentEventRecord } from '../../src/db/tables/rig-agent-events.table';

// ── Test fixtures ──────────────────────────────────────────────────────────

let nextId = 1;

function makeEvent(event_type: string, data: Record<string, unknown>): RigAgentEventRecord {
  return {
    id: nextId++,
    agent_id: 'test-agent',
    event_type,
    data,
    created_at: new Date().toISOString(),
  };
}

function messageUpdated(
  id: string,
  role: 'user' | 'assistant',
  extra: Record<string, unknown> = {}
) {
  return makeEvent('message.updated', {
    sessionID: 'sess-1',
    info: { id, role, sessionID: 'sess-1', ...extra },
  });
}

function messageCompleted(
  id: string,
  role: 'user' | 'assistant',
  extra: Record<string, unknown> = {}
) {
  return makeEvent('message.completed', {
    sessionID: 'sess-1',
    info: { id, role, sessionID: 'sess-1', ...extra },
  });
}

function textPartUpdated(
  messageID: string,
  partId: string,
  text: string,
  extra: Record<string, unknown> = {}
) {
  return makeEvent('message_part.updated', {
    sessionID: 'sess-1',
    part: { id: partId, messageID, type: 'text', text, ...extra },
  });
}

function toolPartUpdated(
  messageID: string,
  partId: string,
  overrides: Record<string, unknown> = {}
) {
  return makeEvent('message_part.updated', {
    sessionID: 'sess-1',
    part: {
      id: partId,
      messageID,
      type: 'tool',
      callID: 'call-1',
      tool: 'bash',
      state: {
        status: 'completed',
        input: {},
        output: 'ok',
        title: 'bash',
        metadata: {},
        time: { start: 1, end: 2 },
      },
      ...overrides,
    },
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('reconstructConversation', () => {
  describe('basic happy path', () => {
    it('reconstructs a simple user -> assistant exchange', () => {
      const events = [
        textPartUpdated('msg-u1', 'part-u1', 'Hello, world!'),
        messageUpdated('msg-u1', 'user'),
        textPartUpdated('msg-a1', 'part-a1', 'Hi there!'),
        messageCompleted('msg-a1', 'assistant'),
      ];

      const turns = reconstructConversation(events);

      expect(turns).toEqual<ConversationTurn[]>([
        { role: 'user', content: 'Hello, world!', toolCalls: [] },
        { role: 'assistant', content: 'Hi there!', toolCalls: [] },
      ]);
    });

    it('concatenates multiple text parts in a single assistant message', () => {
      const events = [
        textPartUpdated('msg-a1', 'part-1', 'First '),
        textPartUpdated('msg-a1', 'part-2', 'second '),
        textPartUpdated('msg-a1', 'part-3', 'third'),
        messageCompleted('msg-a1', 'assistant'),
      ];

      const turns = reconstructConversation(events);

      expect(turns).toHaveLength(1);
      expect(turns[0]?.content).toBe('First second third');
      expect(turns[0]?.toolCalls).toEqual([]);
    });

    it('uses the most recent text for a part when updated multiple times', () => {
      // Part events carry the full accumulated text on each update
      const events = [
        textPartUpdated('msg-a1', 'part-1', 'Hel'),
        textPartUpdated('msg-a1', 'part-1', 'Hello'),
        textPartUpdated('msg-a1', 'part-1', 'Hello world'),
        messageCompleted('msg-a1', 'assistant'),
      ];

      const turns = reconstructConversation(events);

      expect(turns[0]?.content).toBe('Hello world');
    });

    it('preserves message order (insertion order)', () => {
      const events = [
        textPartUpdated('msg-u1', 'p-u1', 'Question'),
        messageUpdated('msg-u1', 'user'),
        textPartUpdated('msg-a1', 'p-a1', 'Answer'),
        messageCompleted('msg-a1', 'assistant'),
        textPartUpdated('msg-u2', 'p-u2', 'Follow-up'),
        messageUpdated('msg-u2', 'user'),
        textPartUpdated('msg-a2', 'p-a2', 'Follow answer'),
        messageCompleted('msg-a2', 'assistant'),
      ];

      const turns = reconstructConversation(events);

      expect(turns.map(t => t.content)).toEqual([
        'Question',
        'Answer',
        'Follow-up',
        'Follow answer',
      ]);
    });
  });

  describe('message event variants', () => {
    it('handles message.completed in addition to message.updated', () => {
      const events = [
        textPartUpdated('msg-a1', 'p1', 'Done.'),
        makeEvent('message.completed', {
          sessionID: 'sess-1',
          info: { id: 'msg-a1', role: 'assistant', sessionID: 'sess-1' },
        }),
      ];

      const turns = reconstructConversation(events);
      expect(turns[0]?.content).toBe('Done.');
      expect(turns[0]?.toolCalls).toEqual([]);
    });

    it('handles message.part.updated (dot variant) as well as message_part.updated', () => {
      const events = [
        makeEvent('message.part.updated', {
          sessionID: 'sess-1',
          part: { id: 'p1', messageID: 'msg-a1', type: 'text', text: 'dot variant' },
        }),
        messageCompleted('msg-a1', 'assistant'),
      ];

      const turns = reconstructConversation(events);
      expect(turns[0]?.content).toBe('dot variant');
    });

    it('accepts parts before the message info event arrives', () => {
      // Parts may arrive before message.updated in the event stream
      const events = [
        textPartUpdated('msg-a1', 'p1', 'early text'),
        messageUpdated('msg-a1', 'assistant'),
      ];

      const turns = reconstructConversation(events);
      expect(turns[0]?.content).toBe('early text');
    });
  });

  describe('tool call tracking', () => {
    it('captures tool call summaries in assistant turns with text', () => {
      const events = [
        textPartUpdated('msg-a1', 'p-text', 'Let me run that for you.'),
        toolPartUpdated('msg-a1', 'p-tool'),
        messageCompleted('msg-a1', 'assistant'),
      ];

      const turns = reconstructConversation(events);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.content).toBe('Let me run that for you.');
      expect(turns[0]?.toolCalls).toHaveLength(1);
      expect(turns[0]?.toolCalls[0]?.tool).toBe('bash');
      expect(turns[0]?.toolCalls[0]?.status).toBe('completed');
      expect(turns[0]?.toolCalls[0]?.summary).toContain('bash');
    });

    it('includes tool-only assistant turns with tool call summaries as content', () => {
      const events = [
        toolPartUpdated('msg-a1', 'tool-p1'),
        messageCompleted('msg-a1', 'assistant'),
      ];

      const turns = reconstructConversation(events);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.toolCalls).toHaveLength(1);
      expect(turns[0]?.content).toContain('bash');
    });

    it('captures multiple tool calls per turn', () => {
      const events = [
        textPartUpdated('msg-a1', 'p-text', 'Running commands.'),
        toolPartUpdated('msg-a1', 'tool-1', {
          tool: 'bash',
          state: { status: 'completed', title: 'git status', output: 'clean' },
        }),
        toolPartUpdated('msg-a1', 'tool-2', {
          tool: 'edit',
          state: { status: 'completed', title: 'src/foo.ts' },
        }),
        messageCompleted('msg-a1', 'assistant'),
      ];

      const turns = reconstructConversation(events);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.toolCalls).toHaveLength(2);
      expect(turns[0]?.toolCalls[0]?.tool).toBe('bash');
      expect(turns[0]?.toolCalls[0]?.summary).toContain('git status');
      expect(turns[0]?.toolCalls[1]?.tool).toBe('edit');
      expect(turns[0]?.toolCalls[1]?.summary).toContain('src/foo.ts');
    });

    it('handles tool parts without state gracefully', () => {
      const events = [
        makeEvent('message_part.updated', {
          sessionID: 'sess-1',
          part: {
            id: 'tool-p1',
            messageID: 'msg-a1',
            type: 'tool',
            tool: 'read',
          },
        }),
        messageCompleted('msg-a1', 'assistant'),
      ];

      const turns = reconstructConversation(events);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.toolCalls[0]?.tool).toBe('read');
      expect(turns[0]?.toolCalls[0]?.status).toBe('unknown');
    });

    it('handles tool parts without tool name gracefully', () => {
      const events = [
        makeEvent('message_part.updated', {
          sessionID: 'sess-1',
          part: {
            id: 'tool-p1',
            messageID: 'msg-a1',
            type: 'tool',
            state: { status: 'completed', output: 'done' },
          },
        }),
        messageCompleted('msg-a1', 'assistant'),
      ];

      const turns = reconstructConversation(events);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.toolCalls[0]?.tool).toBe('unknown');
    });
  });

  describe('edge cases', () => {
    it('skips synthetic text parts', () => {
      const events = [
        textPartUpdated('msg-a1', 'p-synth', 'injected context', { synthetic: true }),
        textPartUpdated('msg-a1', 'p-real', 'real reply'),
        messageCompleted('msg-a1', 'assistant'),
      ];

      const turns = reconstructConversation(events);
      expect(turns[0]?.content).toBe('real reply');
    });

    it('skips ignored text parts', () => {
      const events = [
        textPartUpdated('msg-a1', 'p-ignored', 'ignored text', { ignored: true }),
        textPartUpdated('msg-a1', 'p-real', 'visible text'),
        messageCompleted('msg-a1', 'assistant'),
      ];

      const turns = reconstructConversation(events);
      expect(turns[0]?.content).toBe('visible text');
    });

    it('skips assistant messages with no content at all', () => {
      // message.updated with no parts — likely a partial/crashed session
      const events = [messageUpdated('msg-a1', 'assistant')];

      const turns = reconstructConversation(events);
      expect(turns).toHaveLength(0);
    });

    it('skips user messages with no text and no summary', () => {
      const events = [messageUpdated('msg-u1', 'user')];

      const turns = reconstructConversation(events);
      expect(turns).toHaveLength(0);
    });

    it('uses summary.body as fallback for user messages without text parts', () => {
      const events = [
        messageUpdated('msg-u1', 'user', {
          summary: { title: 'A question', body: 'What is 2+2?' },
        }),
      ];

      const turns = reconstructConversation(events);
      expect(turns[0]?.content).toBe('What is 2+2?');
      expect(turns[0]?.toolCalls).toEqual([]);
    });

    it('handles malformed events gracefully (non-object data)', () => {
      const events: RigAgentEventRecord[] = [
        makeEvent('message.updated', { bad: 'no info field here' }),
        textPartUpdated('msg-a1', 'p1', 'still works'),
        messageCompleted('msg-a1', 'assistant'),
      ];

      const turns = reconstructConversation(events);
      expect(turns[0]?.content).toBe('still works');
    });

    it('handles unknown event types gracefully', () => {
      const events = [
        makeEvent('session.idle', { sessionID: 'sess-1' }),
        makeEvent('agent.exited', { reason: 'completed' }),
        textPartUpdated('msg-a1', 'p1', 'the answer'),
        messageCompleted('msg-a1', 'assistant'),
      ];

      const turns = reconstructConversation(events);
      expect(turns[0]?.content).toBe('the answer');
    });

    it('returns empty array for empty event list', () => {
      expect(reconstructConversation([])).toEqual([]);
    });
  });

  describe('truncation', () => {
    it('truncates to the most recent maxTurns turns', () => {
      const events: RigAgentEventRecord[] = [];
      for (let i = 0; i < 10; i++) {
        events.push(textPartUpdated(`msg-u${i}`, `p-u${i}`, `question ${i}`));
        events.push(messageUpdated(`msg-u${i}`, 'user'));
        events.push(textPartUpdated(`msg-a${i}`, `p-a${i}`, `answer ${i}`));
        events.push(messageCompleted(`msg-a${i}`, 'assistant'));
      }

      const turns = reconstructConversation(events, 4);

      expect(turns).toHaveLength(4);
      // Should keep the last 4 turns (turns 8 and 9 of 10)
      expect(turns[0]?.content).toBe('question 8');
      expect(turns[1]?.content).toBe('answer 8');
      expect(turns[2]?.content).toBe('question 9');
      expect(turns[3]?.content).toBe('answer 9');
    });

    it('does not truncate when turns <= maxTurns', () => {
      const events = [
        textPartUpdated('msg-u1', 'p-u1', 'hi'),
        messageUpdated('msg-u1', 'user'),
        textPartUpdated('msg-a1', 'p-a1', 'hello'),
        messageCompleted('msg-a1', 'assistant'),
      ];

      expect(reconstructConversation(events, 2)).toHaveLength(2);
      expect(reconstructConversation(events, 10)).toHaveLength(2);
    });

    it('respects maxTurns of 1', () => {
      const events = [
        textPartUpdated('msg-u1', 'p-u1', 'first'),
        messageUpdated('msg-u1', 'user'),
        textPartUpdated('msg-a1', 'p-a1', 'last'),
        messageCompleted('msg-a1', 'assistant'),
      ];

      const turns = reconstructConversation(events, 1);
      expect(turns[0]?.content).toBe('last');
    });

    it('uses default maxTurns of 50', () => {
      const events: RigAgentEventRecord[] = [];
      for (let i = 0; i < 60; i++) {
        events.push(textPartUpdated(`msg-a${i}`, `p-a${i}`, `turn ${i}`));
        events.push(messageCompleted(`msg-a${i}`, 'assistant'));
      }

      const turns = reconstructConversation(events);
      expect(turns).toHaveLength(50);
      expect(turns[49]?.content).toBe('turn 59');
    });
  });
});

describe('formatTranscriptForRedispatch', () => {
  it('formats turns with role labels', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'Fix the bug', toolCalls: [] },
      { role: 'assistant', content: 'Looking into it.', toolCalls: [] },
    ];

    const result = formatTranscriptForRedispatch(turns);
    expect(result).toContain('[User]: Fix the bug');
    expect(result).toContain('[Assistant]: Looking into it.');
  });

  it('includes tool call summaries', () => {
    const turns: ConversationTurn[] = [
      {
        role: 'assistant',
        content: 'Let me check.',
        toolCalls: [
          { tool: 'bash', status: 'completed', summary: 'bash: git status -> clean' },
          { tool: 'edit', status: 'completed', summary: 'edit: src/foo.ts -> completed' },
        ],
      },
    ];

    const result = formatTranscriptForRedispatch(turns);
    expect(result).toContain('[Tool calls]:');
    expect(result).toContain('  - bash: git status -> clean');
    expect(result).toContain('  - edit: src/foo.ts -> completed');
  });

  it('truncates to fit maxChars budget from the most recent turns', () => {
    const turns: ConversationTurn[] = [];
    for (let i = 0; i < 100; i++) {
      turns.push({ role: 'user', content: `question ${i} ${'x'.repeat(200)}`, toolCalls: [] });
      turns.push({ role: 'assistant', content: `answer ${i} ${'y'.repeat(200)}`, toolCalls: [] });
    }

    const result = formatTranscriptForRedispatch(turns, 2000);
    // Should contain later turns, not earlier ones
    expect(result).toContain('question 99');
    expect(result).not.toContain('question 0');
    expect(result.length).toBeLessThanOrEqual(2500); // some headroom for the last included turn
  });

  it('returns empty string for empty turns', () => {
    expect(formatTranscriptForRedispatch([])).toBe('');
  });

  it('always includes at least the most recent turn even if it exceeds budget', () => {
    const turns: ConversationTurn[] = [
      { role: 'assistant', content: 'x'.repeat(500), toolCalls: [] },
    ];

    const result = formatTranscriptForRedispatch(turns, 100);
    expect(result).toContain('x'.repeat(500));
  });
});
