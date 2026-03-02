import type { CustomLlm } from '@kilocode/db/schema';
import type { OpenRouterChatCompletionRequest } from '@kilocode/llm-shared';

// Custom LLM request handler using Vercel AI SDK
// Full implementation to be ported from src/lib/custom-llm/customLlmRequest.ts
export async function customLlmRequest(
  customLlm: CustomLlm,
  body: OpenRouterChatCompletionRequest,
  userId: string,
  taskId: string | undefined,
  isKiloClient: boolean
): Promise<Response> {
  // TODO: Port full custom LLM implementation
  // For now, return a not-implemented error
  return Response.json(
    {
      error: 'Custom LLM support is not yet available in the worker',
      message: 'Please use the main API endpoint for custom LLM requests.',
    },
    { status: 501 }
  );
}
