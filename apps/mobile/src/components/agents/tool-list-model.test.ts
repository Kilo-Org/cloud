// oxlint-disable max-lines
import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  buildResultRowsModel,
  buildTodoListModel,
  RESULT_ROW_CAP,
  RESULT_ROW_CHARACTER_CAP,
  TODO_CONTENT_CHARACTER_CAP,
  TODO_TASK_CAP,
} from './tool-list-model';

function mustBe<T>(value: T | null, message: string): NonNullable<T> {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

function makeCompletedTodoPart(overrides: {
  tool?: string;
  metadataTodos?: unknown;
  inputTodos?: unknown;
  output?: string;
}): ToolPart {
  const input: Record<string, unknown> =
    overrides.inputTodos === undefined ? {} : { todos: overrides.inputTodos };
  const metadata: Record<string, unknown> =
    overrides.metadataTodos === undefined ? {} : { todos: overrides.metadataTodos };
  const tool = overrides.tool ?? 'todoread';
  return {
    id: 'todo-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-1',
    tool,
    state: {
      status: 'completed',
      input,
      output: overrides.output ?? '',
      title: tool,
      metadata,
      time: { start: 0, end: 1 },
    },
  };
}

describe('buildResultRowsModel — splitting', () => {
  it('splits output into one row per line', () => {
    const model = buildResultRowsModel('a\nb\nc', 'list');
    expect(model).toEqual({
      caption: undefined,
      rows: [
        { text: 'a', emphasis: false },
        { text: 'b', emphasis: false },
        { text: 'c', emphasis: false },
      ],
      truncated: false,
    });
  });

  it('drops blank-only lines', () => {
    const model = buildResultRowsModel('a\n\n  \nb', 'list');
    expect(model.rows).toEqual([
      { text: 'a', emphasis: false },
      { text: 'b', emphasis: false },
    ]);
  });

  it('returns no rows and no caption for empty output', () => {
    expect(buildResultRowsModel('', 'list')).toEqual({
      caption: undefined,
      rows: [],
      truncated: false,
    });
  });
});

describe('buildResultRowsModel — caption lifting', () => {
  it('lifts a grep Found line into the caption', () => {
    const model = buildResultRowsModel('Found 2 matches\nsrc/app.ts:\n  Line 1: x', 'grep');
    expect(model.caption).toBe('Found 2 matches');
    expect(model.rows[0]).toEqual({ text: 'src/app.ts:', emphasis: true });
    expect(model.rows[1]).toEqual({ text: 'Line 1: x', emphasis: false });
  });

  it('lifts a glob Found line into the caption', () => {
    const output = 'Found 2 file(s) matching "src/**/*.ts":\nsrc/a.ts\nsrc/b.ts';
    const model = buildResultRowsModel(output, 'glob');
    expect(model.caption).toBe('Found 2 file(s) matching "src/**/*.ts":');
    expect(model.rows).toEqual([
      { text: 'src/a.ts', emphasis: false },
      { text: 'src/b.ts', emphasis: false },
    ]);
  });

  it('keeps a non-Found first line as a row', () => {
    const model = buildResultRowsModel('src/a.ts', 'list');
    expect(model.caption).toBeUndefined();
    expect(model.rows).toEqual([{ text: 'src/a.ts', emphasis: false }]);
  });
});

describe('buildResultRowsModel — grep rows', () => {
  it('emphasizes header rows and trims indented match rows', () => {
    const output = 'Found 1 match\nsrc/a.ts:\n  Line 1:   return 1;\n  Line 5: hello';
    const model = buildResultRowsModel(output, 'grep');
    expect(model.rows).toEqual([
      { text: 'src/a.ts:', emphasis: true },
      { text: 'Line 1:   return 1;', emphasis: false },
      { text: 'Line 5: hello', emphasis: false },
    ]);
  });
});

describe('buildResultRowsModel — glob rows', () => {
  it('drops the --- separator', () => {
    const model = buildResultRowsModel('src/a.ts\nsrc/b.ts\n---', 'glob');
    expect(model.rows).toEqual([
      { text: 'src/a.ts', emphasis: false },
      { text: 'src/b.ts', emphasis: false },
    ]);
    expect(model.truncated).toBe(false);
  });

  it('folds the truncation marker into the flag', () => {
    const model = buildResultRowsModel('src/a.ts\n---\n[3 files truncated]', 'glob');
    expect(model.rows).toEqual([{ text: 'src/a.ts', emphasis: false }]);
    expect(model.truncated).toBe(true);
  });
});

describe('buildResultRowsModel — live CLI shapes', () => {
  it('lifts glob No files found into the caption and keeps no rows', () => {
    const model = buildResultRowsModel('No files found', 'glob');
    expect(model.caption).toBe('No files found');
    expect(model.rows).toEqual([]);
    expect(model.truncated).toBe(false);
  });

  it('keeps a single glob path as one row with no caption', () => {
    const model = buildResultRowsModel('/repo/apps/mobile/AGENTS.md', 'glob');
    expect(model.caption).toBeUndefined();
    expect(model.rows).toEqual([{ text: '/repo/apps/mobile/AGENTS.md', emphasis: false }]);
    expect(model.truncated).toBe(false);
  });

  it('keeps every glob path as a row', () => {
    const model = buildResultRowsModel('/repo/a.ts\n/repo/b.ts\n/repo/c.ts', 'glob');
    expect(model.rows).toEqual([
      { text: '/repo/a.ts', emphasis: false },
      { text: '/repo/b.ts', emphasis: false },
      { text: '/repo/c.ts', emphasis: false },
    ]);
  });

  it('drops the opencode truncated note and flags truncation', () => {
    const output =
      '/repo/a.ts\n/repo/b.ts\n\n(Results are truncated: showing first 100 results. Consider using a more specific path or pattern.)';
    const model = buildResultRowsModel(output, 'glob');
    expect(model.rows).toEqual([
      { text: '/repo/a.ts', emphasis: false },
      { text: '/repo/b.ts', emphasis: false },
    ]);
    expect(model.truncated).toBe(true);
  });

  it('drops the core truncated note and flags truncation', () => {
    const output = '/repo/a.ts\n\n(Results truncated: showing first 1 files.)';
    const model = buildResultRowsModel(output, 'glob');
    expect(model.rows).toEqual([{ text: '/repo/a.ts', emphasis: false }]);
    expect(model.truncated).toBe(true);
  });

  it('drops the partial note without flagging truncation', () => {
    const output = '/repo/a.ts\n\n(Some discovered files could not be read.)';
    const model = buildResultRowsModel(output, 'glob');
    expect(model.rows).toEqual([{ text: '/repo/a.ts', emphasis: false }]);
    expect(model.truncated).toBe(false);
  });

  it('lifts grep No files found into the caption and keeps no rows', () => {
    const model = buildResultRowsModel('No files found', 'grep');
    expect(model.caption).toBe('No files found');
    expect(model.rows).toEqual([]);
  });

  it('keeps the live grep header and match rows', () => {
    const output = 'Found 1 matches\n/repo/src/a.ts:\n  Line 1: hello';
    const model = buildResultRowsModel(output, 'grep');
    expect(model.caption).toBe('Found 1 matches');
    expect(model.rows).toEqual([
      { text: '/repo/src/a.ts:', emphasis: true },
      { text: 'Line 1: hello', emphasis: false },
    ]);
  });

  it('drops grep truncated and partial notes without adding rows', () => {
    const output =
      'Found 2 matches\n/repo/src/a.ts:\n  Line 1: hello\n\n' +
      '(Results truncated. Consider using a more specific path or pattern.)\n' +
      '(Some paths were inaccessible.)';
    const model = buildResultRowsModel(output, 'grep');
    expect(model.caption).toBe('Found 2 matches');
    expect(model.rows).toEqual([
      { text: '/repo/src/a.ts:', emphasis: true },
      { text: 'Line 1: hello', emphasis: false },
    ]);
    expect(model.truncated).toBe(true);
  });
});

describe('buildResultRowsModel — list rows', () => {
  it('renders every line as a plain row', () => {
    const model = buildResultRowsModel('added.ts\napp.ts\ngone.ts', 'list');
    expect(model.rows).toEqual([
      { text: 'added.ts', emphasis: false },
      { text: 'app.ts', emphasis: false },
      { text: 'gone.ts', emphasis: false },
    ]);
  });
});

describe('buildResultRowsModel — caps', () => {
  it('caps the row count at RESULT_ROW_CAP', () => {
    const many = Array.from({ length: RESULT_ROW_CAP + 10 }, (_, i) => `row${i}`).join('\n');
    const model = buildResultRowsModel(many, 'list');
    expect(model.rows).toHaveLength(RESULT_ROW_CAP);
    expect(model.truncated).toBe(true);
  });

  it('slices a single row at the character cap', () => {
    const long = 'x'.repeat(RESULT_ROW_CHARACTER_CAP + 10);
    const model = buildResultRowsModel(long, 'list');
    expect(model.rows[0]?.text).toHaveLength(RESULT_ROW_CHARACTER_CAP);
    expect(model.truncated).toBe(true);
  });

  it('slices a caption at the character cap and flags truncation', () => {
    const long = `Found 1${'x'.repeat(RESULT_ROW_CHARACTER_CAP + 5)}`;
    const model = buildResultRowsModel(long, 'list');
    expect(model.caption).toHaveLength(RESULT_ROW_CHARACTER_CAP);
    expect(model.truncated).toBe(true);
  });
});

describe('buildTodoListModel — source priority', () => {
  it('prefers metadata.todos over input and output', () => {
    const part = makeCompletedTodoPart({
      metadataTodos: [{ content: 'meta', status: 'completed' }],
      inputTodos: [{ content: 'input', status: 'pending' }],
      output: JSON.stringify([{ content: 'output', status: 'pending' }]),
    });
    const model = mustBe(buildTodoListModel(part), 'model');
    expect(model).toEqual({ tasks: [{ content: 'meta', status: 'completed' }], truncated: false });
  });

  it('falls back to input.todos when metadata carries none', () => {
    const part = makeCompletedTodoPart({
      inputTodos: [{ content: 'from input', status: 'in_progress' }],
      output: JSON.stringify([{ content: 'from output', status: 'pending' }]),
    });
    const model = mustBe(buildTodoListModel(part), 'model');
    expect(model.tasks).toEqual([{ content: 'from input', status: 'in_progress' }]);
  });

  it('parses the output when metadata and input carry no todos', () => {
    const part = makeCompletedTodoPart({
      output: JSON.stringify([{ content: 'from output', status: 'cancelled' }]),
    });
    const model = mustBe(buildTodoListModel(part), 'model');
    expect(model.tasks).toEqual([{ content: 'from output', status: 'cancelled' }]);
  });

  it('ignores a non-array metadata todos and uses input', () => {
    const part = makeCompletedTodoPart({
      metadataTodos: 'not an array',
      inputTodos: [{ content: 'input wins', status: 'pending' }],
    });
    const model = mustBe(buildTodoListModel(part), 'model');
    expect(model.tasks).toEqual([{ content: 'input wins', status: 'pending' }]);
  });

  it('renders input-backed todos while running (D11, no status gate)', () => {
    const part: ToolPart = {
      id: 'todo-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'todowrite',
      state: {
        status: 'running',
        input: { todos: [{ content: 'mid', status: 'in_progress' }] },
        metadata: {},
        time: { start: 0 },
      },
    };
    const model = mustBe(buildTodoListModel(part), 'model');
    expect(model.tasks).toEqual([{ content: 'mid', status: 'in_progress' }]);
  });
});

describe('buildTodoListModel — status mapping', () => {
  it('maps each known status exactly and unknown to pending', () => {
    const part = makeCompletedTodoPart({
      output: JSON.stringify([
        { content: 'a', status: 'pending' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'completed' },
        { content: 'd', status: 'cancelled' },
        { content: 'e', status: 'queued' },
        { content: 'f' },
      ]),
    });
    const model = mustBe(buildTodoListModel(part), 'model');
    expect(model.tasks.map(task => task.status)).toEqual([
      'pending',
      'in_progress',
      'completed',
      'cancelled',
      'pending',
      'pending',
    ]);
  });

  it('discards non-object array entries instead of rendering blank tasks', () => {
    const part = makeCompletedTodoPart({ output: JSON.stringify([42, 'x']) });
    expect(buildTodoListModel(part)).toEqual({ tasks: [], truncated: false });
  });

  it('discards entries without a non-empty trimmed content', () => {
    const part = makeCompletedTodoPart({
      output: JSON.stringify([
        { content: '', status: 'pending' },
        { content: '   ', status: 'completed' },
        { content: '\t', status: 'cancelled' },
        { content: '  real task  ', status: 'in_progress' },
      ]),
    });
    const model = mustBe(buildTodoListModel(part), 'model');
    expect(model.tasks).toEqual([{ content: '  real task  ', status: 'in_progress' }]);
  });
});

describe('buildTodoListModel — null cases', () => {
  it('returns null when no source is a parseable array', () => {
    const part = makeCompletedTodoPart({
      metadataTodos: 'not an array',
      inputTodos: 42,
      output: 'not json',
    });
    expect(buildTodoListModel(part)).toBeNull();
  });

  it('returns null when the output parses to a non-array', () => {
    const part = makeCompletedTodoPart({ output: '{"a":1}' });
    expect(buildTodoListModel(part)).toBeNull();
  });

  it('returns an empty model for an empty parsed array', () => {
    const part = makeCompletedTodoPart({ output: '[]' });
    expect(buildTodoListModel(part)).toEqual({ tasks: [], truncated: false });
  });
});

describe('buildTodoListModel — caps', () => {
  it('caps the task list at TODO_TASK_CAP', () => {
    const many = Array.from({ length: TODO_TASK_CAP + 5 }, (_, i) => ({
      content: `t${i}`,
      status: 'pending',
    }));
    const part = makeCompletedTodoPart({ output: JSON.stringify(many) });
    const model = mustBe(buildTodoListModel(part), 'model');
    expect(model.tasks).toHaveLength(TODO_TASK_CAP);
    expect(model.truncated).toBe(true);
  });

  it('slices task content at TODO_CONTENT_CHARACTER_CAP', () => {
    const long = 'x'.repeat(TODO_CONTENT_CHARACTER_CAP + 50);
    const part = makeCompletedTodoPart({
      output: JSON.stringify([{ content: long, status: 'pending' }]),
    });
    const model = mustBe(buildTodoListModel(part), 'model');
    expect(model.tasks[0]?.content).toHaveLength(TODO_CONTENT_CHARACTER_CAP);
    expect(model.truncated).toBe(true);
  });

  it('does not flag truncation when only a trailing invalid entry sits beyond the cap', () => {
    const valid = Array.from({ length: TODO_TASK_CAP }, (_, i) => ({
      content: `t${i}`,
      status: 'pending',
    }));
    const todos = [...valid, { content: '   ', status: 'pending' }];
    const part = makeCompletedTodoPart({ output: JSON.stringify(todos) });
    const model = mustBe(buildTodoListModel(part), 'model');
    expect(model.tasks).toHaveLength(TODO_TASK_CAP);
    expect(model.tasks[0]?.content).toBe('t0');
    expect(model.truncated).toBe(false);
  });

  it('does not let invalid entries consume the task cap', () => {
    const todos = Array.from({ length: TODO_TASK_CAP + 100 }, (_, i) => ({
      content: i % 10 === 0 ? '' : `t${i}`,
      status: 'pending',
    }));
    const part = makeCompletedTodoPart({ output: JSON.stringify(todos) });
    const model = mustBe(buildTodoListModel(part), 'model');
    expect(model.tasks).toHaveLength(TODO_TASK_CAP);
    expect(model.tasks[0]?.content).toBe('t1');
    expect(model.truncated).toBe(true);
  });
});
