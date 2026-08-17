// Pure models that turn grep/glob/list and todo tool output into display
// rows for the tool detail sheet.
//
// Result rows (D6): grep keeps its `path:` headers as emphasized rows and
// trims the indented match rows; glob drops the trailing `---` separator and
// folds the `[N files truncated]` marker into the model's flag; list is one
// plain row per line. All kinds lift a leading `Found N ...` summary into a
// muted caption.
//
// Task rows (D8): the task array comes from `state.metadata.todos`, then
// `state.input.todos`, then a JSON parse of `state.output`. Unknown status
// strings map to `pending`. Entries without a non-empty trimmed content are
// dropped before the cap applies. No parseable array means null and the caller
// keeps its raw-output fallback.
//
// Row and character caps bound the rendered size. The models are cheap
// per-render computations, so the tool-card bodies call them without a hook.

import { type ToolPart } from '@kilocode/cloud-agent-sdk';

/** Rows kept per result output. Longer outputs flag `truncated`. */
export const RESULT_ROW_CAP = 500;

/** Characters kept per row. Longer rows are sliced and flag `truncated`. */
export const RESULT_ROW_CHARACTER_CAP = 2000;

/** Tasks kept per todo list. Longer lists flag `truncated`. */
export const TODO_TASK_CAP = 500;

/** Characters kept per task. Longer tasks are sliced and flag `truncated`. */
export const TODO_CONTENT_CHARACTER_CAP = 500;

export type ResultRow = {
  text: string;
  /** True for grep file-header rows (`path:`), rendered with medium weight. */
  emphasis: boolean;
};

export type ResultRowsModel = {
  /** The lifted `Found N ...` summary line. Undefined when absent. */
  caption: string | undefined;
  rows: ResultRow[];
  truncated: boolean;
};

export type ResultRowsKind = 'grep' | 'glob' | 'list';

const CAPTION_PATTERN = /^Found \d+/;
const TRUNCATED_LINE_PATTERN = /^\[\d+ files truncated\]$/;

/**
 * Convert a tool output string into display rows. Every line becomes at most
 * one row; blank-only lines are dropped. Returns the rows plus the optional
 * caption and the truncation flag (never throws).
 */
export function buildResultRowsModel(output: string, kind: ResultRowsKind): ResultRowsModel {
  const lines = output.split('\n').filter(line => line.trim().length > 0);

  let caption: string | undefined = undefined;
  const first = lines[0];
  if (first !== undefined && CAPTION_PATTERN.test(first)) {
    caption = first.slice(0, RESULT_ROW_CHARACTER_CAP);
  }

  const rows: ResultRow[] = [];
  let truncated = caption !== undefined && caption.length < (first?.length ?? 0);

  for (const line of lines.slice(caption === undefined ? 0 : 1)) {
    const isGlobSeparator = kind === 'glob' && line === '---';
    const isGlobTruncation = kind === 'glob' && TRUNCATED_LINE_PATTERN.test(line);

    if (isGlobTruncation) {
      truncated = true;
    }

    if (!isGlobSeparator && !isGlobTruncation) {
      if (rows.length >= RESULT_ROW_CAP) {
        truncated = true;
        break;
      }

      let text = line;
      let emphasis = false;
      if (kind === 'grep') {
        emphasis = !/^\s/.test(line) && line.endsWith(':');
        text = emphasis ? line : line.trimStart();
      }

      if (text.length > RESULT_ROW_CHARACTER_CAP) {
        text = text.slice(0, RESULT_ROW_CHARACTER_CAP);
        truncated = true;
      }
      rows.push({ text, emphasis });
    }
  }

  return { caption, rows, truncated };
}

export type TodoTask = {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
};

export type TodoListModel = {
  tasks: TodoTask[];
  truncated: boolean;
};

const TODO_STATUS: Record<string, TodoTask['status']> = {
  pending: 'pending',
  in_progress: 'in_progress',
  completed: 'completed',
  cancelled: 'cancelled',
};

function mapTodoStatus(status: unknown): TodoTask['status'] {
  return typeof status === 'string' ? (TODO_STATUS[status] ?? 'pending') : 'pending';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Convert a todo tool part into task rows. Source priority: metadata.todos,
 * then input.todos, then a JSON parse of the output. Entries without a
 * non-empty trimmed content are dropped before the cap applies, so a trailing
 * invalid entry never flags truncation by itself. Returns null when no source
 * is a parseable array, so the caller keeps its raw-output fallback.
 */
export function buildTodoListModel(part: ToolPart): TodoListModel | null {
  const todos = findTodoList(part);
  if (todos === null) {
    return null;
  }

  let truncated = false;
  const tasks: TodoTask[] = [];
  for (const item of todos) {
    if (isRecord(item) && typeof item.content === 'string' && item.content.trim().length > 0) {
      if (tasks.length >= TODO_TASK_CAP) {
        truncated = true;
        break;
      }

      let content = item.content;
      if (content.length > TODO_CONTENT_CHARACTER_CAP) {
        content = content.slice(0, TODO_CONTENT_CHARACTER_CAP);
        truncated = true;
      }
      tasks.push({ content, status: mapTodoStatus(item.status) });
    }
  }

  return { tasks, truncated };
}

function findTodoList(part: ToolPart): unknown[] | null {
  const state = part.state;

  if (state.status !== 'pending') {
    const metadataTodos = state.metadata?.todos;
    if (Array.isArray(metadataTodos)) {
      return metadataTodos;
    }
  }

  const inputTodos = state.input.todos;
  if (Array.isArray(inputTodos)) {
    return inputTodos;
  }

  if (state.status === 'completed' && state.output.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(state.output);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Not a JSON array; fall through to the null fallback.
    }
  }

  return null;
}
