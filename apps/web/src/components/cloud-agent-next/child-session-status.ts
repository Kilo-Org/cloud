import type { ChildSessionHydrationState } from '@kilocode/cloud-agent-sdk';
import type { SessionStatus } from '@kilocode/cloud-agent-sdk/schemas';
import type { StoredMessage, ToolPart } from './types';
import { isMessageStreaming } from './types';

export function isBackgroundChildTask(taskToolPart?: ToolPart): boolean {
  const state = taskToolPart?.state;
  return (
    state?.status === 'completed' &&
    ((isRecord(state.metadata) && state.metadata['status'] === 'running') ||
      (isRecord(state.input) && state.input['background'] === true))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getChildSessionTaskStatus({
  taskToolPart,
  childMessages,
  sessionStatus,
  childError,
  hydrationState,
}: {
  taskToolPart?: ToolPart;
  childMessages: StoredMessage[];
  sessionStatus?: SessionStatus;
  childError?: string | null;
  hydrationState?: ChildSessionHydrationState;
}): ToolPart['state']['status'] | 'unavailable' | undefined {
  const taskStatus = taskToolPart?.state.status;
  if (taskStatus === 'pending' || taskStatus === 'error') return taskStatus;
  if (
    sessionStatus?.type === 'busy' ||
    sessionStatus?.type === 'retry' ||
    sessionStatus?.type === 'question' ||
    sessionStatus?.type === 'permission'
  )
    return 'running';

  const latestMessage = childMessages.at(-1);
  if (childError || (latestMessage?.info.role === 'assistant' && latestMessage.info.error))
    return 'error';
  if (taskStatus === 'running') return taskStatus;
  if (sessionStatus?.type === 'idle' || sessionStatus?.type === 'scheduled') return 'completed';
  if (latestMessage) {
    if (
      latestMessage.info.role === 'user' ||
      isMessageStreaming(latestMessage) ||
      latestMessage.info.finish === 'tool-calls'
    )
      return 'running';
    return 'completed';
  }

  // A completed background tool acknowledges dispatch, not child completion.
  if (isBackgroundChildTask(taskToolPart) && hydrationState)
    return hydrationState.status === 'idle' || hydrationState.status === 'loading'
      ? 'running'
      : 'unavailable';
  return taskStatus;
}
