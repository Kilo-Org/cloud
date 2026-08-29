import { browser } from '#imports';
import { z } from 'zod';
import type { WebMcpToolCallEvent } from '@/src/shared/agent-conversation';
import {
  WEB_MCP_DISCOVER_MESSAGE,
  WEB_MCP_EXECUTE_MESSAGE,
  isTabDebuggerResponse,
  normalizeEvalTabResult,
} from '@/src/shared/tab-debugger';
import type { NormalizedEvalTabResult, WebMcpDiscoveryResult } from '@/src/shared/tab-debugger';
import { capRemoteMcpToolResult } from '@/src/shared/remote-mcp-tools';
import {
  ExecutionStoppedError,
  isExecutionStopped,
  normalizeExecutionGuard,
} from '@/src/shared/agent-tool-results';
import type { ExecutionGuard } from '@/src/shared/agent-tool-results';

// Chrome returns JSON strings. Keep non-JSON strings and null unchanged.
const stringSchema = z.string();
const jsonRecordSchema = z.record(z.string(), z.unknown());
const parseWebMcpResult = (value: unknown) => {
  const asString = stringSchema.safeParse(value);
  if (!asString.success) {
    return value;
  }
  try {
    const parsed: unknown = JSON.parse(asString.data);
    return parsed;
  } catch {
    return asString.data;
  }
};

const isRecordObject = (value: unknown): value is Record<string, unknown> =>
  jsonRecordSchema.safeParse(value).success;
const isWebMcpDiscoveryResult = (value: unknown): value is WebMcpDiscoveryResult =>
  isRecordObject(value) &&
  stringSchema.safeParse(value['documentId']).success &&
  Array.isArray(value['tools']);

/** Confirmed discovery failures disable page tools; uncertain completion interrupts the turn. */
export const discoverWebMcpTools = async (
  tabId: number,
  executionGuard?: ExecutionGuard
): Promise<WebMcpDiscoveryResult | undefined> => {
  normalizeExecutionGuard(executionGuard)();
  try {
    const response: unknown = await browser.runtime.sendMessage({
      tabId,
      type: WEB_MCP_DISCOVER_MESSAGE,
    });
    if (!isTabDebuggerResponse(response)) {
      throw new ExecutionStoppedError('effects_uncertain', 'interrupted', true);
    }
    if (response.ok && response.type !== WEB_MCP_DISCOVER_MESSAGE) {
      throw new ExecutionStoppedError('effects_uncertain', 'interrupted', true);
    }
    const result = normalizeEvalTabResult(response.ok ? response.result : response);
    if (result.effectsUncertain) {
      throw new ExecutionStoppedError('effects_uncertain', 'interrupted', true);
    }
    if (!result.ok) {
      return undefined;
    }
    return isWebMcpDiscoveryResult(result.value) ? result.value : undefined;
  } catch (error) {
    if (isExecutionStopped(error)) {
      throw error;
    }
    throw new ExecutionStoppedError('effects_uncertain', 'interrupted', true);
  }
};

/** The background checks the live document and definition before running a page tool. */
export const executeWebMcpToolCall = async (
  event: WebMcpToolCallEvent,
  executionGuard?: ExecutionGuard
): Promise<NormalizedEvalTabResult> => {
  normalizeExecutionGuard(executionGuard)();
  let dispatched = false;
  try {
    const message = {
      arguments: JSON.stringify(event.arguments),
      definitionSignature: event.definitionSignature,
      documentId: event.documentId,
      tabId: event.tabId,
      toolName: event.name,
      type: WEB_MCP_EXECUTE_MESSAGE,
    };
    dispatched = true;
    const response: unknown = await browser.runtime.sendMessage(message);
    if (!isTabDebuggerResponse(response)) {
      return {
        effectsUncertain: true,
        error: 'Extension background returned an invalid response.',
        ok: false,
      };
    }
    if (!response.ok) {
      return normalizeEvalTabResult(response);
    }
    if (response.type !== WEB_MCP_EXECUTE_MESSAGE) {
      return {
        effectsUncertain: true,
        error: 'Extension background returned the wrong response.',
        ok: false,
      };
    }
    const result = normalizeEvalTabResult(response.result);
    return result.ok
      ? { ...result, value: capRemoteMcpToolResult(parseWebMcpResult(result.value)) }
      : result;
  } catch (error) {
    if (isExecutionStopped(error)) {
      throw error;
    }
    return {
      effectsUncertain: dispatched,
      error: error instanceof Error ? error.message : 'Failed to run WebMCP tool.',
      ok: false,
    };
  }
};
