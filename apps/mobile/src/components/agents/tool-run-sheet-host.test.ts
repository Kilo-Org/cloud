import { type Part, type StoredMessage, type ToolPart } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { indexPartsById } from './tool-run-sheet-host';

// The host module mounts the run sheet, whose react-native imports cannot load
// in this node project. The index under test never touches the sheet.
vi.mock('./tool-run-sheet', () => ({ ToolRunSheet: 'ToolRunSheet' }));

function makeCompletedToolPart(id: string, tool = 'bash'): ToolPart {
  return {
    id,
    sessionID: 's1',
    messageID: `msg-${id}`,
    type: 'tool',
    callID: `call-${id}`,
    tool,
    state: {
      status: 'completed',
      input: { command: 'echo hi' },
      output: '',
      title: tool,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

/** A tool call still streaming: the sheet must track this part as it resolves. */
function makeRunningToolPart(id: string): ToolPart {
  return {
    id,
    sessionID: 's1',
    messageID: `msg-${id}`,
    type: 'tool',
    callID: `call-${id}`,
    tool: 'bash',
    state: {
      status: 'running',
      input: { command: 'echo hi' },
      time: { start: 1 },
    },
  };
}

function makeTextPart(id: string): Part {
  return {
    id,
    sessionID: 's1',
    messageID: `msg-${id}`,
    type: 'text',
    text: 'hello',
  };
}

function makeMessage(parts: Part[]): StoredMessage {
  return {
    info: {
      id: `msg-${parts[0]?.id ?? 'empty'}`,
      sessionID: 's1',
      role: 'user',
      time: { created: 1 },
      agent: 'test',
      model: { providerID: 'kilo', modelID: 'claude-sonnet-4' },
    },
    parts,
  };
}

describe('indexPartsById', () => {
  it('resolves every part id across several messages to its part', () => {
    const tool = makeCompletedToolPart('t1');
    const text = makeTextPart('x1');
    const other = makeCompletedToolPart('t2', 'read');
    const messages = [makeMessage([tool, text]), makeMessage([other])];

    const index = indexPartsById(messages);

    expect(index.size).toBe(3);
    expect(index.get('t1')).toBe(tool);
    expect(index.get('x1')).toBe(text);
    expect(index.get('t2')).toBe(other);
  });

  it('yields the new part object for a streaming id when messages is rebuilt', () => {
    const streaming = makeRunningToolPart('t1');
    const streamingIndex = indexPartsById([makeMessage([streaming])]);

    const resolved = makeCompletedToolPart('t1');
    const rebuiltIndex = indexPartsById([makeMessage([resolved])]);

    expect(streamingIndex.get('t1')).toBe(streaming);
    expect(rebuiltIndex.get('t1')).toBe(resolved);
    expect(rebuiltIndex.get('t1')).not.toBe(streaming);
  });

  it('resolves an unknown id to undefined', () => {
    const index = indexPartsById([makeMessage([makeCompletedToolPart('t1')])]);

    expect(index.get('nope')).toBeUndefined();
  });

  it('returns an empty index for no messages', () => {
    expect(indexPartsById([]).size).toBe(0);
  });
});
