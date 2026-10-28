import { type StoredMessage } from '@kilocode/cloud-agent-sdk';

import { isToolPart } from './part-types';
import { buildTodoListModel, type TodoTask } from './tool-list-model';

export type SessionTodoSummary = {
  /** The `todowrite` part that holds the current list; the Tasks sheet opens it. */
  partId: string;
  completed: number;
  /** Tasks that still count: every task except the cancelled ones. */
  total: number;
  /** The in-progress task, else the first pending task. */
  current: TodoTask;
};

/**
 * The session's current todo list: the latest `todowrite` the model sent.
 * Each `todowrite` replaces the whole list, so only the newest one counts. A
 * failed write never replaced the list, so it is skipped. Returns null when the
 * session has no list or every task is done or cancelled.
 */
export function selectSessionTodoSummary(
  messages: readonly StoredMessage[]
): SessionTodoSummary | null {
  const latest = findLatestTodoList(messages);
  if (latest === null) {
    return null;
  }
  const { partId, tasks } = latest;
  const current =
    tasks.find(task => task.status === 'in_progress') ??
    tasks.find(task => task.status === 'pending');
  if (current === undefined) {
    return null;
  }
  return {
    partId,
    completed: tasks.filter(task => task.status === 'completed').length,
    total: tasks.filter(task => task.status !== 'cancelled').length,
    current,
  };
}

function findLatestTodoList(
  messages: readonly StoredMessage[]
): { partId: string; tasks: TodoTask[] } | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const parts = messages[messageIndex]?.parts ?? [];
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if (
        part !== undefined &&
        isToolPart(part) &&
        part.tool === 'todowrite' &&
        part.state.status !== 'error'
      ) {
        const model = buildTodoListModel(part);
        if (model !== null) {
          return { partId: part.id, tasks: model.tasks };
        }
      }
    }
  }
  return null;
}
