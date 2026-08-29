import { createToolResult } from './agent-conversation';
import type { AgentConversationEvent } from './agent-conversation';
import { normalizeEvalTabResult } from './tab-debugger';
import type { EvalTabResult, NormalizedEvalTabResult } from './tab-debugger';

type ToolCallEvent = Extract<AgentConversationEvent, { readonly type: 'tool-call' }>;
export type ToolResultEvent = Extract<AgentConversationEvent, { readonly type: 'tool-result' }> & {
  readonly effectsUncertain: boolean;
};

/** Synchronous authority check at an action boundary. Owners throw when their lease ends. */
export type ExecutionGuard = () => void;

export class ExecutionStoppedError extends Error {
  readonly reason: string;
  readonly status: 'cancelled' | 'interrupted';
  readonly effectsUncertain: boolean;

  constructor(
    reason: string,
    status: 'cancelled' | 'interrupted' = 'interrupted',
    effectsUncertain = false
  ) {
    super(reason);
    this.name = status === 'cancelled' ? 'AbortError' : 'ExecutionStoppedError';
    this.reason = reason;
    this.status = status;
    this.effectsUncertain = effectsUncertain;
  }
}

export const isExecutionStopped = (error: unknown): boolean =>
  error instanceof ExecutionStoppedError || (error instanceof Error && error.name === 'AbortError');

export const normalizeExecutionGuard =
  (executionGuard: ExecutionGuard | undefined, signal?: AbortSignal): ExecutionGuard =>
  () => {
    try {
      executionGuard?.();
      // Old local callers supply only an AbortSignal, or neither input. An owner guard never replaces Stop.
      // Remove this fallback after every guardless local caller retires.
      signal?.throwIfAborted();
    } catch (error) {
      if (error instanceof ExecutionStoppedError) {
        throw error;
      }
      if (isExecutionStopped(error)) {
        throw new ExecutionStoppedError('cancelled', 'cancelled');
      }
      throw new ExecutionStoppedError(error instanceof Error ? error.message : String(error));
    }
  };

const toToolResultEvent = (
  toolCall: ToolCallEvent,
  result: NormalizedEvalTabResult
): ToolResultEvent => ({
  ...createToolResult(
    result.ok && !result.effectsUncertain
      ? { ok: true, toolCallId: toolCall.id, value: result.value }
      : {
          error: result.ok ? 'Tool completion is uncertain.' : result.error,
          ok: false,
          toolCallId: toolCall.id,
        }
  ),
  effectsUncertain: result.effectsUncertain,
});

interface ToolExecutionOptions {
  readonly executionGuard?: ExecutionGuard | undefined;
  readonly onResult?: (result: ToolResultEvent) => void;
}

// eslint-disable-next-line max-params -- Preserve the old signal argument; owners observe settled results before a later interruption.
export const runToolCalls = <ToolCall extends ToolCallEvent>(
  toolCalls: ToolCall[],
  executeToolCall: (toolCall: ToolCall) => Promise<EvalTabResult>,
  signal?: AbortSignal,
  options: ToolExecutionOptions = {}
): Promise<ToolResultEvent[]> => {
  const guard = normalizeExecutionGuard(options.executionGuard, signal);
  const runNext = async (index: number, results: ToolResultEvent[]): Promise<ToolResultEvent[]> => {
    const toolCall = toolCalls[index];

    // Old signal-only callers receive settled results on Stop; guarded owners check termination after the batch.
    // Remove this return form after those signal-only callers retire.
    if (toolCall === undefined || signal?.aborted === true) {
      return results;
    }
    guard();

    let result: NormalizedEvalTabResult | undefined = undefined;
    try {
      result = normalizeEvalTabResult(await executeToolCall(toolCall));
    } catch (error) {
      if (isExecutionStopped(error)) {
        throw error;
      }
      // The executor was dispatched. A lost result does not prove that its action stopped.
      result = {
        effectsUncertain: true,
        error: `${toolCall.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        ok: false,
      };
    }
    const event = toToolResultEvent(toolCall, result);
    options.onResult?.(event);
    const nextResults = [...results, event];
    if (result.effectsUncertain) {
      return nextResults;
    }
    return runNext(index + 1, nextResults);
  };

  return runNext(0, []);
};
