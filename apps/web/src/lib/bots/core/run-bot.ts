import type OpenAI from 'openai';
import type { FeatureValue } from '@/lib/feature-detection';
import { sendProxiedChatCompletion } from '@/lib/llm-proxy-helpers';
import type { OpenRouterChatCompletionRequest } from '@/lib/providers/openrouter/types';

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatCompletionResponse = OpenAI.Chat.Completions.ChatCompletion;
type ToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;

export type BotToolResult = {
  content: string;
};

export type BotRunInput = {
  authToken: string;
  model: string;
  systemPrompt: string;
  userMessage: string;
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
  toolExecutor: (toolCall: ToolCall) => Promise<BotToolResult>;
  maxIterations?: number;
  logPrefix?: string;
  requestOptions: {
    version: string;
    userAgent: string;
    organizationId?: string;
    feature?: FeatureValue;
  };
};

export type BotRunResult = {
  response: string;
  toolCallsMade: string[];
  error?: string;
};

export async function runBot(input: BotRunInput): Promise<BotRunResult> {
  const logPrefix = input.logPrefix ?? '[BotEngine]';
  const toolCallsMade: string[] = [];
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: input.systemPrompt,
    },
    {
      role: 'user',
      content: input.userMessage,
    },
  ];

  let finalResponse: string | null = null;
  let errorMessage: string | undefined;
  const maxIterations = input.maxIterations ?? 5;
  let iteration = 0;

  while (finalResponse === null && iteration < maxIterations) {
    iteration++;
    console.log(`${logPrefix} Tool loop iteration ${iteration}/${maxIterations}`);
    console.log(`${logPrefix} Sending request to chat completions endpoint...`);

    const body: OpenRouterChatCompletionRequest = {
      model: input.model,
      messages,
    };

    if (input.tools && input.tools.length > 0) {
      body.tools = input.tools;
      body.tool_choice = 'auto';
    }

    const result = await sendProxiedChatCompletion<ChatCompletionResponse>({
      authToken: input.authToken,
      version: input.requestOptions.version,
      userAgent: input.requestOptions.userAgent,
      body,
      organizationId: input.requestOptions.organizationId,
      feature: input.requestOptions.feature,
    });

    if (!result.ok) {
      console.error(`${logPrefix} API error response:`, result.error);
      finalResponse = `Sorry, there was an error calling the AI service (${result.status}): ${result.error.slice(0, 200)}`;
      break;
    }

    const responseBody = result.data;
    console.log(`${logPrefix} Response body parsed, choices count:`, responseBody.choices?.length);
    const choice = responseBody.choices?.[0];

    if (!choice) {
      console.log(
        `${logPrefix} No choice in response, response body:`,
        JSON.stringify(responseBody)
      );
      finalResponse = 'Sorry, I could not generate a response.';
      errorMessage = 'No choice in OpenRouter response';
      break;
    }

    const message = choice.message;
    console.log(
      `${logPrefix} Message received - content length:`,
      message.content?.length,
      'tool_calls:',
      message.tool_calls?.length || 0
    );
    console.log(`${logPrefix} Message content preview:`, message.content?.slice(0, 200));

    if (message.tool_calls && message.tool_calls.length > 0) {
      console.log(`${logPrefix} Tool calls detected:`, message.tool_calls.length);

      messages.push({
        role: 'assistant',
        content: message.content,
        tool_calls: message.tool_calls,
      });
      console.log(
        `${logPrefix} Added assistant message to history, total messages:`,
        messages.length
      );

      for (const toolCall of message.tool_calls) {
        console.log(
          `${logPrefix} Processing tool call:`,
          toolCall.type,
          toolCall.type === 'function' ? toolCall.function.name : 'N/A'
        );

        toolCallsMade.push(toolCall.type === 'function' ? toolCall.function.name : 'N/A');

        try {
          const toolResult = await input.toolExecutor(toolCall);
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResult.content,
          });
          console.log(
            `${logPrefix} Added tool result to history, total messages:`,
            messages.length
          );
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(`${logPrefix} Error executing tool:`, errMsg, error);
          errorMessage = errMsg;
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: `Error executing tool: ${errMsg}`,
          });
        }
      }
    } else {
      console.log(`${logPrefix} No tool calls, setting final response`);
      finalResponse = message.content ?? 'Sorry, I could not generate a response.';
    }
  }

  if (finalResponse === null) {
    console.log(`${logPrefix} Max iterations reached, setting timeout message`);
    finalResponse = 'Sorry, the request took too long to process.';
    errorMessage = 'Max iterations reached';
  }

  console.log(`${logPrefix} Final response length:`, finalResponse.length);
  console.log(`${logPrefix} Final response preview:`, finalResponse.slice(0, 500));

  return {
    response: finalResponse,
    toolCallsMade,
    error: errorMessage,
  };
}
