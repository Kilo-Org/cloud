import { browser } from '#imports';
import type { KiloBrowserToolCallEvent } from '@/src/shared/agent-conversation';
import type { BrowserCaller } from '@/src/shared/browser-caller';
import {
  BROWSER_TOOL_MESSAGE,
  RELEASE_BROWSER_CALLER_MESSAGE,
  isTabDebuggerResponse,
} from '@/src/shared/tab-debugger';
import type { BrowserTabTakeOverRequest, EvalTabResult } from '@/src/shared/tab-debugger';
import { requestTabTakeOver } from './browser-tab-takeover';

type BrowserToolCallOutcome =
  | { readonly kind: 'result'; readonly result: EvalTabResult }
  | { readonly kind: 'takeOver'; readonly request: BrowserTabTakeOverRequest };

/**
 * The browser tools run behind the background's per-tab runtime; the side
 * panel sends the model-facing tool name, the upstream arguments and its caller
 * identity verbatim. An unreachable background and a thrown or malformed
 * message resolve to an error result — never a rejected promise — so a
 * transport failure becomes a tool error the turn loop can show.
 */
const sendBrowserToolCall = async (
  event: KiloBrowserToolCallEvent,
  caller: BrowserCaller,
  takeOver: boolean
): Promise<BrowserToolCallOutcome> => {
  const response: unknown = await browser.runtime.sendMessage({
    arguments: event.arguments,
    caller,
    tabId: event.tabId,
    takeOver,
    tool: event.name,
    type: BROWSER_TOOL_MESSAGE,
  });

  if (!isTabDebuggerResponse(response)) {
    throw new Error('Extension background returned an invalid response.');
  }

  if (!response.ok) {
    throw new Error(response.error);
  }

  if (response.type !== BROWSER_TOOL_MESSAGE) {
    throw new Error('Extension background returned the wrong response.');
  }

  if ('takeOver' in response) {
    return { kind: 'takeOver', request: response.takeOver };
  }

  return { kind: 'result', result: response.result };
};

export const executeKiloBrowserToolCall = async (
  event: KiloBrowserToolCallEvent,
  caller: BrowserCaller
): Promise<EvalTabResult> => {
  try {
    const first = await sendBrowserToolCall(event, caller, false);

    if (first.kind === 'result') {
      return first.result;
    }

    // The tab belongs to a CLI agent; only the user's answer in the panel may take it.
    const accepted = await requestTabTakeOver({
      sessionTitle: first.request.sessionTitle,
      tabId: first.request.tabId,
    });

    if (!accepted) {
      return {
        error: `The tab stays with ${first.request.sessionTitle}. Ask the user to stop that session or choose another tab.`,
        ok: false,
      };
    }

    const second = await sendBrowserToolCall(event, caller, true);

    return second.kind === 'result'
      ? second.result
      : {
          error: 'The tab is still held by another browser session (tab_busy). Retry the call.',
          ok: false,
        };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Failed to run the browser tool.',
      ok: false,
    };
  }
};

/**
 * Drops the caller's tab leases and ref registries. A turn or a workflow run
 * releases on its way out so the next owner — another conversation, or a CLI
 * agent waiting in the queue — can take the tab.
 */
export const releaseBrowserCaller = async (caller: BrowserCaller): Promise<void> => {
  try {
    await browser.runtime.sendMessage({
      caller,
      type: RELEASE_BROWSER_CALLER_MESSAGE,
    });
  } catch {
    // The background restarted and holds no lease for this caller.
  }
};
