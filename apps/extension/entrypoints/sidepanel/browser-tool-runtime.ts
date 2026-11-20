import { browser } from '#imports';
import type { KiloBrowserToolCallEvent } from '@/src/shared/agent-conversation';
import type { BrowserCaller } from '@/src/shared/browser-caller';
import {
  BROWSER_TOOL_MESSAGE,
  DISPOSE_BROWSER_CALLER_MESSAGE,
  RELEASE_BROWSER_CALLER_MESSAGE,
  isTabDebuggerResponse,
} from '@/src/shared/tab-debugger';
import type { BrowserTabTakeOverRequest, EvalTabResult } from '@/src/shared/tab-debugger';
import { requestTabTakeOver } from './browser-tab-takeover';

type BrowserToolCallOutcome =
  | { readonly kind: 'result'; readonly result: EvalTabResult }
  | { readonly kind: 'takeOver'; readonly request: BrowserTabTakeOverRequest };

/** One call's identity and mode: the caller, and whether its tool set is read-only. */
interface BrowserToolCallTarget {
  readonly caller: BrowserCaller;
  readonly safeMode: boolean;
}

/**
 * The browser tools run behind the background's per-tab runtime; the side
 * panel sends the model-facing tool name, the upstream arguments and its caller
 * identity verbatim. An unreachable background and a thrown or malformed
 * message resolve to an error result — never a rejected promise — so a
 * transport failure becomes a tool error the turn loop can show.
 */
const sendBrowserToolCall = async (
  event: KiloBrowserToolCallEvent,
  { caller, safeMode }: BrowserToolCallTarget,
  takeOver: boolean
): Promise<BrowserToolCallOutcome> => {
  const response: unknown = await browser.runtime.sendMessage({
    arguments: event.arguments,
    caller,
    safeMode,
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

/** The caller's identity and mode: the panel's conversation, and whether its tool set is read-only. */
export interface BrowserToolCaller {
  readonly caller: BrowserCaller;
  readonly safeMode?: boolean | undefined;
}

export const executeKiloBrowserToolCall = async (
  event: KiloBrowserToolCallEvent,
  browserCaller: BrowserCaller | BrowserToolCaller,
  signal?: AbortSignal
): Promise<EvalTabResult> => {
  // A bare caller is a caller that has no mode: danger mode, whose tool set always has the dialog handler.
  const target: BrowserToolCallTarget =
    'caller' in browserCaller
      ? { caller: browserCaller.caller, safeMode: browserCaller.safeMode === true }
      : { caller: browserCaller, safeMode: false };

  try {
    const first = await sendBrowserToolCall(event, target, false);

    if (first.kind === 'result') {
      return first.result;
    }

    // The tab belongs to a CLI agent; only the user's answer in the panel may take it.
    const answer = await requestTabTakeOver({
      sessionTitle: first.request.sessionTitle,
      signal,
      tabId: first.request.tabId,
    });

    if (answer === 'stopped' || signal?.aborted === true) {
      return { error: 'Stopped before the tab was taken over.', ok: false };
    }

    if (answer === 'cancel') {
      return {
        error: `The tab stays with ${first.request.sessionTitle}. Ask the user to stop that session or choose another tab.`,
        ok: false,
      };
    }

    const second = await sendBrowserToolCall(event, target, true);

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
 * Ends the caller's tab leases without touching its refs. A turn ends this
 * way so the next owner — another conversation, or a CLI agent waiting in the
 * queue — can take the tab, while a ref this conversation snapshotted earlier
 * keeps resolving in its next turn.
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

/**
 * Drops the caller's tab leases and ref registries for good: its conversation
 * was deleted, its workflow run finished, or its agent session closed. Closing
 * a turn is not disposal.
 */
export const disposeBrowserCaller = async (caller: BrowserCaller): Promise<void> => {
  try {
    await browser.runtime.sendMessage({
      caller,
      type: DISPOSE_BROWSER_CALLER_MESSAGE,
    });
  } catch {
    // The background restarted and holds no state for this caller.
  }
};
