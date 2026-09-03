import {
  type Part,
  type ReasoningPart,
  type StoredMessage,
  type ToolPart,
} from '@kilocode/cloud-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findPartById,
  getPartDetailTitle,
  shouldAutoFollowPartDetail,
  shouldCenterPartDetail,
} from './part-detail-model';

const { getToolDisplay } = vi.hoisted(() => ({
  getToolDisplay: vi.fn(),
}));
vi.mock('./tool-card-display', () => ({ getToolDisplay }));

function makeToolPart(
  overrides: { tool?: string; input?: Record<string, unknown>; state?: ToolPart['state'] } = {}
): ToolPart {
  return {
    id: 'tool-1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool',
    callID: 'call-1',
    tool: overrides.tool ?? 'bash',
    state: overrides.state ?? {
      status: 'completed',
      input: overrides.input ?? { command: 'echo hi' },
      output: '',
      title: 'bash',
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

function makeReasoningPart(text: string, ended = true): ReasoningPart {
  return {
    id: 'r1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'reasoning',
    text,
    time: { start: 1, end: ended ? 2 : undefined },
  };
}

function makeTextPart(): Part {
  return {
    id: 'text-1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'text',
    text: 'hello',
  };
}

function makeMessage(parts: Part[]): StoredMessage {
  return {
    info: {
      id: `msg-${parts[0]?.id ?? 'x'}`,
      sessionID: 's1',
      role: 'user',
      time: { created: 1 },
      agent: 'test',
      model: { providerID: 'kilo', modelID: 'claude-sonnet-4' },
    },
    parts,
  };
}

describe('findPartById', () => {
  beforeEach(() => {
    getToolDisplay.mockReset();
  });

  it('finds a part across multiple messages', () => {
    const messages = [
      makeMessage([makeToolPart(), makeReasoningPart('r')]),
      makeMessage([makeTextPart()]),
    ];
    expect(findPartById(messages, 'tool-1')?.id).toBe('tool-1');
    expect(findPartById(messages, 'text-1')?.type).toBe('text');
  });

  it('returns null for an unknown id', () => {
    const messages = [makeMessage([makeToolPart()])];
    expect(findPartById(messages, 'nope')).toBeNull();
  });

  it('returns null for empty messages', () => {
    expect(findPartById([], 'nope')).toBeNull();
  });
});

describe('getPartDetailTitle', () => {
  beforeEach(() => {
    getToolDisplay.mockReset();
  });

  it('combines the display title and subtitle for tools', () => {
    getToolDisplay.mockReturnValue({ title: 'bash', subtitle: 'echo hi' });
    expect(getPartDetailTitle(makeToolPart())).toBe('bash: echo hi');
  });

  it('uses the display title alone when the tool has no subtitle', () => {
    getToolDisplay.mockReturnValue({ title: 'glob' });
    expect(getPartDetailTitle(makeToolPart({ tool: 'glob' }))).toBe('glob');
  });

  it('labels streaming reasoning as Thinking', () => {
    expect(getPartDetailTitle(makeReasoningPart('reasoning', false))).toBe('Thinking');
  });

  it('labels completed reasoning as Thought', () => {
    expect(getPartDetailTitle(makeReasoningPart('reasoning', true))).toBe('Thought');
  });

  it('falls back to Details for other part types', () => {
    expect(getPartDetailTitle(makeTextPart())).toBe('Details');
  });
});

const completedState: Extract<ToolPart['state'], { status: 'completed' }> = {
  status: 'completed',
  input: {},
  output: '',
  title: '',
  metadata: {},
  time: { start: 1, end: 2 },
};
const errorState: Extract<ToolPart['state'], { status: 'error' }> = {
  status: 'error',
  input: {},
  error: 'Failed',
  time: { start: 1, end: 2 },
};

describe('shouldCenterPartDetail', () => {
  it('centers missing details, but not reasoning', () => {
    expect(shouldCenterPartDetail(null, false)).toBe(true);
    expect(shouldCenterPartDetail(makeReasoningPart(''), false)).toBe(false);
  });

  it.each(['file.ts', 'file.md', 'file.mdx'])('centers only an empty read of %s', filePath => {
    for (const text of ['', 'content', ' ']) {
      const part = makeToolPart({
        tool: 'read',
        state: {
          ...completedState,
          input: { filePath },
          output: 'raw envelope',
          metadata: {
            display: {
              type: 'file',
              path: filePath,
              text,
              lineStart: 1,
              lineEnd: 0,
              totalLines: 0,
            },
          },
        },
      });
      expect(shouldCenterPartDetail(part, false)).toBe(text === '');
    }
  });

  it.each(['file.ts', 'file.md'])(
    'centers final empty writes of %s, including errors',
    filePath => {
      for (const state of [completedState, errorState]) {
        for (const content of ['', undefined, 42, 'body', ' ']) {
          const part = makeToolPart({
            tool: 'write',
            state: { ...state, input: { filePath, content } },
          });
          expect(shouldCenterPartDetail(part, false)).toBe(!content || content === 42);
        }
      }
    }
  );

  it.each(['todoread', 'todowrite'])('centers empty %s without a completed-status guard', tool => {
    const states: ToolPart['state'][] = [
      completedState,
      errorState,
      { status: 'pending', input: {}, raw: '' },
      { status: 'running', input: {}, time: { start: 1 } },
    ];
    for (const state of states) {
      for (const content of ['', ' ', 'Task']) {
        const part = makeToolPart({ tool, state: { ...state, input: { todos: [{ content }] } } });
        expect(shouldCenterPartDetail(part, false)).toBe(content.trim() === '');
      }
      expect(shouldCenterPartDetail(makeToolPart({ tool: 'write', state }), false)).toBe(
        state.status === 'completed' || state.status === 'error'
      );
    }
    expect(
      shouldCenterPartDetail(
        makeToolPart({ tool, state: { ...completedState, output: 'raw fallback' } }),
        false
      )
    ).toBe(false);
  });

  it.each(['glob', 'grep'])('centers only status-only %s results', tool => {
    for (const output of [
      'No files found',
      'Found 0 files',
      'No files found\n(Results truncated)',
    ]) {
      expect(
        shouldCenterPartDetail(makeToolPart({ tool, state: { ...completedState, output } }), false)
      ).toBe(true);
    }
    for (const output of ['Found 1 file\nfile.ts', 'raw fallback', '', ' ']) {
      expect(
        shouldCenterPartDetail(makeToolPart({ tool, state: { ...completedState, output } }), false)
      ).toBe(false);
    }
  });

  it.each(['image/png', 'application/pdf'])(
    'centers only unavailable %s attachments without other content',
    mime => {
      const attachment = {
        id: 'file-1',
        sessionID: 's1',
        messageID: 'm1',
        type: 'file' as const,
        mime,
        url: '',
      };
      const tool = mime === 'image/png' ? 'read' : 'send_file';
      const state = {
        ...completedState,
        attachments: [attachment],
        output: tool === 'read' ? 'Image read successfully' : '',
      };
      const part = makeToolPart({ tool, state });
      expect(shouldCenterPartDetail(part, false)).toBe(true);
      expect(shouldCenterPartDetail(part, true)).toBe(false);
      expect(
        shouldCenterPartDetail(
          makeToolPart({ tool: 'custom_tool', state: { ...state, input: { path: 'file' } } }),
          false
        )
      ).toBe(false);
      expect(
        shouldCenterPartDetail(
          makeToolPart({ tool: 'send_file', state: { ...state, output: 'result' } }),
          false
        )
      ).toBe(false);
    }
  );

  it('keeps an empty state inline beside available attachments', () => {
    const attachment = {
      id: 'file-1',
      sessionID: 's1',
      messageID: 'm1',
      type: 'file' as const,
      mime: 'image/png',
      url: '',
    };
    for (const tool of ['write', 'todoread', 'todowrite', 'glob', 'grep']) {
      const part = makeToolPart({
        tool,
        state: {
          ...completedState,
          input: { todos: [] },
          output: 'No files found',
          attachments: [attachment],
        },
      });
      expect(shouldCenterPartDetail(part, false)).toBe(true);
      expect(shouldCenterPartDetail(part, true)).toBe(false);
    }
  });
});

describe('shouldAutoFollowPartDetail', () => {
  it('returns false for a null part', () => {
    expect(shouldAutoFollowPartDetail(null)).toBe(false);
  });

  it('returns true for a streaming reasoning part', () => {
    expect(shouldAutoFollowPartDetail(makeReasoningPart('thinking', false))).toBe(true);
  });

  it('returns false for a completed reasoning part', () => {
    expect(shouldAutoFollowPartDetail(makeReasoningPart('thought', true))).toBe(false);
  });

  it('returns false for a running tool part', () => {
    const runningTool: ToolPart = {
      id: 'tool-1',
      sessionID: 's1',
      messageID: 'm1',
      type: 'tool',
      callID: 'call-tool-1',
      tool: 'bash',
      state: { status: 'running', input: { command: 'echo hi' }, time: { start: 1 } },
    };
    expect(shouldAutoFollowPartDetail(runningTool)).toBe(false);
  });
});
