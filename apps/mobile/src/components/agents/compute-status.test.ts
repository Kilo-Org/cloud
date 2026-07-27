import { type ReasoningPart, type TextPart, type ToolPart } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it } from 'vitest';

import { computeStatus, SNAPSHOT_PROGRESS_STATUS } from './compute-status';

function makeTextPart(text: string, synthetic?: boolean): TextPart {
  const part: TextPart = {
    id: 't1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'text',
    text,
    time: { start: 1, end: 2 },
  };
  if (synthetic !== undefined) {
    part.synthetic = synthetic;
  }
  return part;
}

function makeReasoningPart(): ReasoningPart {
  return {
    id: 'r1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'reasoning',
    text: 'thinking',
    time: { start: 1, end: 2 },
  };
}

function makeToolPart(tool: string): ToolPart {
  return {
    id: 'tool1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool',
    callID: 'c1',
    tool,
    state: {
      status: 'running',
      input: {},
      time: { start: 1 },
    },
  };
}

describe('computeStatus', () => {
  it('maps snapshot-progress text parts to SNAPSHOT_PROGRESS_STATUS', () => {
    const part = makeTextPart('⠋ Initializing snapshot…', true);
    expect(computeStatus(part)).toBe(SNAPSHOT_PROGRESS_STATUS);
    expect(SNAPSHOT_PROGRESS_STATUS).toBe('Initializing snapshot…');
  });

  it('maps plain text parts to Writing response', () => {
    expect(computeStatus(makeTextPart('Hello'))).toBe('Writing response');
  });

  it('maps reasoning parts to Thinking', () => {
    expect(computeStatus(makeReasoningPart())).toBe('Thinking');
  });

  it('maps known tool parts via the tool status map', () => {
    expect(computeStatus(makeToolPart('bash'))).toBe('Running commands');
    expect(computeStatus(makeToolPart('read'))).toBe('Exploring');
  });

  it('maps unknown tool parts to Considering next steps', () => {
    expect(computeStatus(makeToolPart('unknown-tool'))).toBe('Considering next steps');
  });
});
