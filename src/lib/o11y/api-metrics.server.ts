import { after } from 'next/server';
import { O11Y_SERVICE_URL } from '@/lib/config.server';
import type OpenAI from 'openai';

export type ApiMetricsParams = {
  clientSecret: string;
  provider: string;
  requestedModel: string;
  resolvedModel: string;
  toolsAvailable: string[];
  toolsUsed: string[];
};

export function getToolsAvailable(
  tools: Array<OpenAI.Chat.Completions.ChatCompletionTool> | undefined
): string[] {
  if (!tools) return [];

  return tools.map((tool): string => {
    if (tool.type === 'function') {
      const toolName = tool.function.name.trim();
      return toolName ? `function:${toolName}` : 'function:unknown';
    }

    if (tool.type === 'custom') {
      const toolName = tool.custom.name.trim();
      return toolName ? `custom:${toolName}` : 'custom:unknown';
    }

    return 'unknown:unknown';
  });
}

export function getToolsUsed(
  messages: Array<OpenAI.Chat.Completions.ChatCompletionMessageParam> | undefined
): string[] {
  if (!messages) return [];

  const used = new Array<string>();

  for (const message of messages) {
    if (message.role !== 'assistant') continue;

    for (const toolCall of message.tool_calls ?? []) {
      if (toolCall.type === 'function') {
        const toolName = toolCall.function.name.trim();
        used.push(toolName ? `function:${toolName}` : 'function:unknown');
        continue;
      }

      if (toolCall.type === 'custom') {
        const toolName = toolCall.custom.name.trim();
        used.push(toolName ? `custom:${toolName}` : 'custom:unknown');
        continue;
      }

      used.push('unknown:unknown');
    }
  }

  return used;
}

const apiMetricsUrl = (() => {
  if (!O11Y_SERVICE_URL) return null;
  try {
    return new URL('/ingest/api-metrics', O11Y_SERVICE_URL);
  } catch {
    return null;
  }
})();

export function emitApiMetrics(params: ApiMetricsParams) {
  if (!apiMetricsUrl) return;

  after(async () => {
    await fetch(apiMetricsUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(params),
    }).catch(() => {
      // Best-effort only; never fail the caller request.
    });
  });
}
