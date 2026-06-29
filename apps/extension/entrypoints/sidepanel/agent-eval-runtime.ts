import { browser } from '#imports';
import type { AgentConversationEvent } from '@/src/shared/agent-conversation';
import { EVAL_TAB_MESSAGE, isTabDebuggerResponse } from '@/src/shared/tab-debugger';
import type { EvalTabResult } from '@/src/shared/tab-debugger';

export const executeEvalToolCall = async (
  toolCall: Extract<AgentConversationEvent, { readonly name: 'eval' }>
): Promise<EvalTabResult> => {
  try {
    const response: unknown = await browser.runtime.sendMessage({
      code: toolCall.code,
      tabId: toolCall.tabId,
      type: EVAL_TAB_MESSAGE,
    });

    if (!isTabDebuggerResponse(response)) {
      return { error: 'Extension background returned an invalid response.', ok: false };
    }

    if (!response.ok) {
      return { error: response.error, ok: false };
    }

    if (response.type !== EVAL_TAB_MESSAGE) {
      return { error: 'Extension background returned the wrong response.', ok: false };
    }

    return response.result;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Failed to run eval.',
      ok: false,
    };
  }
};
