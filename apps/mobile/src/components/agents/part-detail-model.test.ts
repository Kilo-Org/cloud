import {
  type Part,
  type ReasoningPart,
  type StoredMessage,
  type ToolPart,
} from '@kilocode/cloud-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findPartById, getPartDetailTitle, shouldAutoFollowPartDetail } from './part-detail-model';

const { getToolDisplay } = vi.hoisted(() => ({
  getToolDisplay: vi.fn(),
}));
vi.mock('./tool-card-display', () => ({ getToolDisplay }));

function makeToolPart(
  overrides: { tool?: string; input?: Record<string, unknown> } = {}
): ToolPart {
  return {
    id: 'tool-1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool',
    callID: 'call-1',
    tool: overrides.tool ?? 'bash',
    state: {
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
