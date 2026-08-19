import { browser } from '#imports';
import type { WebMcpToolCallEvent } from '@/src/shared/agent-conversation';
import { WEB_MCP_EXECUTE_MESSAGE, isTabDebuggerResponse } from '@/src/shared/tab-debugger';
import type { EvalTabResult } from '@/src/shared/tab-debugger';

const MAX_WEB_MCP_RESULT_CHARS = 64 * 1024;

/*
 * Chrome's eval returns a JSON string. Parse it into a structured value so the
 * result enters conversation state as an object, not a quoted string. A
 * non-JSON string and null pass through verbatim.
 */
const parseWebMcpResult = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

// Mirror capRemoteMcpToolResult: keep a result under 64 KiB verbatim; truncate a longer one before it enters conversation state.
const capWebMcpToolResult = (value: unknown): unknown => {
  const serialized = JSON.stringify(value);

  if (serialized === undefined || serialized.length <= MAX_WEB_MCP_RESULT_CHARS) {
    return value;
  }

  return {
    truncated: true,
    value: serialized.slice(0, MAX_WEB_MCP_RESULT_CHARS),
  };
};

/*
 * Run a WebMCP tool call through the background transport. The background
 * re-checks the definition signature against the page's live registration, so
 * a stale call (the page re-registered the tool after the turn started) fails
 * with a stale-tool error instead of running against the wrong definition.
 */
export const executeWebMcpToolCall = async (event: WebMcpToolCallEvent): Promise<EvalTabResult> => {
  try {
    const response: unknown = await browser.runtime.sendMessage({
      arguments: JSON.stringify(event.arguments),
      definitionSignature: event.definitionSignature,
      documentId: event.documentId,
      tabId: event.tabId,
      toolName: event.name,
      type: WEB_MCP_EXECUTE_MESSAGE,
    });

    if (!isTabDebuggerResponse(response)) {
      return { error: 'Extension background returned an invalid response.', ok: false };
    }

    if (!response.ok) {
      return { error: response.error, ok: false };
    }

    if (response.type !== WEB_MCP_EXECUTE_MESSAGE) {
      return { error: 'Extension background returned the wrong response.', ok: false };
    }

    if (!response.result.ok) {
      return response.result;
    }

    return { ok: true, value: capWebMcpToolResult(parseWebMcpResult(response.result.value)) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Failed to run WebMCP tool.',
      ok: false,
    };
  }
};
