import { createToolResult } from './agent-conversation';
import type { AgentConversationEvent } from './agent-conversation';
import type { EvalTabResult } from './tab-debugger';

type EvalToolCallEvent = Extract<AgentConversationEvent, { readonly type: 'tool-call' }>;
type ToolResultEvent = Extract<AgentConversationEvent, { readonly type: 'tool-result' }>;

const toToolResultEvent = (toolCall: EvalToolCallEvent, result: EvalTabResult): ToolResultEvent =>
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

export const runEvalToolCalls = (
  toolCalls: EvalToolCallEvent[],
  executeEvalToolCall: (toolCall: EvalToolCallEvent) => Promise<EvalTabResult>
): Promise<ToolResultEvent[]> => {
  const runNext = async (index: number, results: ToolResultEvent[]): Promise<ToolResultEvent[]> => {
    const toolCall = toolCalls[index];

    if (toolCall === undefined) {
      return results;
    }

    const result = await executeEvalToolCall(toolCall);

    return runNext(index + 1, [...results, toToolResultEvent(toolCall, result)]);
  };

  return runNext(0, []);
};
