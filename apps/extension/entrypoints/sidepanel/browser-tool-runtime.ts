import { browser } from '#imports';
import type { KiloBrowserToolCallEvent } from '@/src/shared/agent-conversation';
import { BROWSER_TOOL_MESSAGE, isTabDebuggerResponse } from '@/src/shared/tab-debugger';
import type { EvalTabResult } from '@/src/shared/tab-debugger';

/*
 * The browser tools run behind the background's per-tab session; the side
 * panel forwards the model-facing tool name and the upstream arguments
 * verbatim. An unreachable background (the service worker is gone) and a
 * thrown or malformed message resolve to an error result — never a rejected
 * promise — so a transport failure becomes a tool error the turn loop can
 * show, the same shape the WebMCP runtime returns.
 */
export const executeKiloBrowserToolCall = async (
  event: KiloBrowserToolCallEvent
): Promise<EvalTabResult> => {
  try {
    const response: unknown = await browser.runtime.sendMessage({
      arguments: event.arguments,
      tabId: event.tabId,
      tool: event.name,
      type: BROWSER_TOOL_MESSAGE,
    });

    if (!isTabDebuggerResponse(response)) {
      return { error: 'Extension background returned an invalid response.', ok: false };
    }

    if (!response.ok) {
      return { error: response.error, ok: false };
    }

    if (response.type !== BROWSER_TOOL_MESSAGE) {
      return { error: 'Extension background returned the wrong response.', ok: false };
    }

    return response.result;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Failed to run the browser tool.',
      ok: false,
    };
  }
};
