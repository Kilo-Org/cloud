import { browser } from '#imports';
import { z } from 'zod';
import type { KiloBrowserToolCallEvent } from '@/src/shared/agent-conversation';
import { EVAL_TAB_MESSAGE, isTabDebuggerResponse } from '@/src/shared/tab-debugger';
import type { EvalTabResult } from '@/src/shared/tab-debugger';

/*
 * The eval tool is a browser tool call now, so the code comes from the call's
 * verbatim arguments. s8 deletes this runtime once the browser tool executor
 * owns `kilo_browser_evaluate`.
 */
const evalArgumentsSchema = z.object({ code: z.string() });

export const executeEvalToolCall = async (
  toolCall: KiloBrowserToolCallEvent
): Promise<EvalTabResult> => {
  const parsedArguments = evalArgumentsSchema.safeParse(toolCall.arguments);

  if (!parsedArguments.success) {
    return { error: 'Eval requires a code argument.', ok: false };
  }

  const { code } = parsedArguments.data;

  try {
    const response: unknown = await browser.runtime.sendMessage({
      code,
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
