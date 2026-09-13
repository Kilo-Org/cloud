import {
  type Part,
  type ReasoningPart,
  type TextPart,
  type ToolPart,
} from '@kilocode/cloud-agent-sdk';
import { type TFunction } from 'i18next';
import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import {
  buildToolRunLabel,
  buildToolRunRows,
  groupMessageParts,
  isCondensableToolPart,
} from './session-tool-run';

// tool-card-display imports the Lucide icon components; the pure project cannot
// parse the Flow-sourced react-native runtime, so stub the module.
vi.mock('@/components/ui/icons', () => ({
  Cpu: 'Cpu',
  Eye: 'Eye',
  FileDiff: 'FileDiff',
  FilePlus: 'FilePlus',
  FileSearch: 'FileSearch',
  FolderOpen: 'FolderOpen',
  Globe: 'Globe',
  ListTodo: 'ListTodo',
  Pencil: 'Pencil',
  Plug: 'Plug',
  Search: 'Search',
  Sparkles: 'Sparkles',
  Terminal: 'Terminal',
}));

const t = i18n.t as TFunction;

function makeToolPart(id: string, tool: string, input: Record<string, unknown> = {}): ToolPart {
  return {
    id,
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool',
    callID: `call-${id}`,
    tool,
    state: {
      status: 'completed',
      input,
      output: '',
      title: tool,
      metadata: {},
      time: { start: 0, end: 1 },
    },
  };
}

function makeTextPart(id: string): TextPart {
  return {
    id,
    sessionID: 's1',
    messageID: 'm1',
    type: 'text',
    text: 'hello',
    time: { start: 0, end: 1 },
  };
}

function makeReasoningPart(id: string): ReasoningPart {
  return {
    id,
    sessionID: 's1',
    messageID: 'm1',
    type: 'reasoning',
    text: 'thinking',
    time: { start: 0, end: 1 },
  };
}

/** A parsed but invisible part (`PartRenderer` renders null for it). */
function makeStepStartPart(id: string): Part {
  return {
    id,
    sessionID: 's1',
    messageID: 'm1',
    type: 'step-start',
  };
}

describe('isCondensableToolPart', () => {
  it('accepts ordinary tools and rejects task, suggest, non-tools, and hidden parts', () => {
    expect(isCondensableToolPart(makeToolPart('a', 'read'))).toBe(true);
    expect(isCondensableToolPart(makeToolPart('b', 'task'))).toBe(false);
    expect(isCondensableToolPart(makeToolPart('c', 'suggest'))).toBe(false);
    expect(isCondensableToolPart(makeToolPart('e', 'plan_enter'))).toBe(false);
    expect(isCondensableToolPart(makeToolPart('f', 'plan_exit'))).toBe(false);
    expect(isCondensableToolPart(makeTextPart('d'))).toBe(false);
  });
});

describe('groupMessageParts', () => {
  it('condenses three consecutive tool parts into one run of three', () => {
    const parts = [
      makeToolPart('t1', 'read', { filePath: 'a.ts' }),
      makeToolPart('t2', 'bash', { command: 'ls' }),
      makeToolPart('t3', 'grep', { pattern: 'foo' }),
    ];

    const groups = groupMessageParts(parts, { condense: true });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('tool-run');
    expect(groups[0]?.parts.map(part => part.id)).toEqual(['t1', 't2', 't3']);
  });

  it('keeps one row per part, in run order, with each part own label', () => {
    const rows = buildToolRunRows([
      makeToolPart('t1', 'read', { filePath: '/repo/app.ts' }),
      makeToolPart('t2', 'bash', { description: 'List files' }),
      makeToolPart('t3', 'edit', { filePath: '/repo/b.ts' }),
    ]);

    expect(rows.map(row => row.id)).toEqual(['t1', 't2', 't3']);
    expect(rows.map(row => row.label)).toEqual(['app.ts', 'List files', 'b.ts']);
    expect(rows.every(row => row.status === 'completed')).toBe(true);
  });

  it('labels the condensed run with the item count and the last label', () => {
    const rows = buildToolRunRows([
      makeToolPart('t1', 'read', { filePath: '/repo/app.ts' }),
      makeToolPart('t2', 'bash', { description: 'List files' }),
      makeToolPart('t3', 'edit', { filePath: '/repo/b.ts' }),
    ]);

    expect(buildToolRunLabel(rows, t)).toBe('3 items; b.ts');
  });

  it('splits a run around a text part', () => {
    const groups = groupMessageParts(
      [
        makeToolPart('t1', 'read'),
        makeToolPart('t2', 'read'),
        makeTextPart('x'),
        makeToolPart('t3', 'read'),
      ],
      { condense: true }
    );

    expect(groups.map(group => group.kind)).toEqual(['tool-run', 'parts', 'parts']);
    expect(groups[0]?.parts.map(part => part.id)).toEqual(['t1', 't2']);
    expect(groups[1]?.parts.map(part => part.id)).toEqual(['x']);
    expect(groups[2]?.parts.map(part => part.id)).toEqual(['t3']);
  });

  it('splits a run around a reasoning part', () => {
    const groups = groupMessageParts(
      [
        makeToolPart('t1', 'read'),
        makeReasoningPart('r1'),
        makeToolPart('t2', 'read'),
        makeToolPart('t3', 'read'),
      ],
      { condense: true }
    );

    expect(groups.map(group => group.kind)).toEqual(['parts', 'parts', 'tool-run']);
    expect(groups[2]?.parts.map(part => part.id)).toEqual(['t2', 't3']);
  });

  it('splits a run around task and suggest parts without counting them', () => {
    const groups = groupMessageParts(
      [
        makeToolPart('t1', 'read'),
        makeToolPart('t2', 'read'),
        makeToolPart('task1', 'task'),
        makeToolPart('t3', 'read'),
        makeToolPart('suggest1', 'suggest'),
        makeToolPart('t4', 'read'),
      ],
      { condense: true }
    );

    expect(groups.map(group => group.kind)).toEqual([
      'tool-run',
      'parts',
      'parts',
      'parts',
      'parts',
    ]);
    expect(groups[0]?.parts.map(part => part.id)).toEqual(['t1', 't2']);
    const taskGroup = groups.find(
      group => group.kind === 'parts' && group.parts[0]?.id === 'task1'
    );
    const suggestGroup = groups.find(
      group => group.kind === 'parts' && group.parts[0]?.id === 'suggest1'
    );
    expect(taskGroup).toBeDefined();
    expect(suggestGroup).toBeDefined();
    expect(groups.filter(group => group.kind === 'tool-run')).toHaveLength(1);
  });

  it('keeps a lone tool part as a parts group of one', () => {
    const groups = groupMessageParts([makeToolPart('t1', 'read')], { condense: true });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('parts');
    expect(groups[0]?.parts.map(part => part.id)).toEqual(['t1']);
  });

  it('leaves every part uncondensed when condense is off', () => {
    const groups = groupMessageParts(
      [makeToolPart('t1', 'read'), makeToolPart('t2', 'read'), makeToolPart('t3', 'read')],
      { condense: false }
    );

    expect(groups.map(group => group.kind)).toEqual(['parts', 'parts', 'parts']);
    expect(groups.map(group => group.parts[0]?.id)).toEqual(['t1', 't2', 't3']);
  });

  it('ignores an invisible step-start part', () => {
    const groups = groupMessageParts(
      [makeStepStartPart('s1'), makeToolPart('t1', 'read'), makeToolPart('t2', 'read')],
      { condense: true }
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('tool-run');
    expect(groups[0]?.parts.map(part => part.id)).toEqual(['t1', 't2']);
  });
});
