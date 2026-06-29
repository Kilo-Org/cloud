import { createToolResult } from './agent-conversation';
import type { AgentConversationEvent } from './agent-conversation';
import type { EvalTabResult } from './tab-debugger';

type ToolCallEvent = Extract<AgentConversationEvent, { readonly type: 'tool-call' }>;
type ToolResultEvent = Extract<AgentConversationEvent, { readonly type: 'tool-result' }>;

const toToolResultEvent = (toolCall: ToolCallEvent, result: EvalTabResult): ToolResultEvent =>
  result.ok
    ? createToolResult({
        ok: true,
        toolCallId: toolCall.id,
        value: result.value,
      })
    : createToolResult({
        error: result.error,
        ok: false,
        toolCallId: toolCall.id,
      });

export const runToolCalls = <ToolCall extends ToolCallEvent>(
  toolCalls: ToolCall[],
  executeToolCall: (toolCall: ToolCall) => Promise<EvalTabResult>,
  signal?: AbortSignal
): Promise<ToolResultEvent[]> => {
  const runNext = async (index: number, results: ToolResultEvent[]): Promise<ToolResultEvent[]> => {
    const toolCall = toolCalls[index];

    // Stop before each call so pressing Stop mid-batch doesn't run later (side-effecting) tools.
    if (toolCall === undefined || signal?.aborted === true) {
      return results;
    }

    const result = await executeToolCall(toolCall);

    return runNext(index + 1, [...results, toToolResultEvent(toolCall, result)]);
  };

  return runNext(0, []);
};
