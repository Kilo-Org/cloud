import { describe, it, expect } from '@jest/globals';
import { fixOpenCodeDuplicateReasoning } from '@/lib/ai-gateway/providers/fixOpenCodeDuplicateReasoning';
import { ReasoningDetailType } from '@/lib/ai-gateway/custom-llm/reasoning-details';
import type { OpenRouterChatCompletionRequest } from '@/lib/ai-gateway/providers/openrouter/types';

function makeRequest(reasoningDetails: unknown[]): OpenRouterChatCompletionRequest {
  return {
    model: 'anthropic/claude-opus-4.7',
    messages: [
      {
        role: 'assistant',
        content: '',
        reasoning_details: reasoningDetails,
      } as never,
    ],
  } as OpenRouterChatCompletionRequest;
}

function getReasoningDetails(request: OpenRouterChatCompletionRequest) {
  const msg = request.messages[0] as { reasoning_details?: unknown[] };
  return msg.reasoning_details ?? [];
}

describe('fixOpenCodeDuplicateReasoning', () => {
  it('deduplicates reasoning items with empty text but identical signatures', () => {
    const signature = 'Eu8BClkIDRgCKkBlUUZG1kCXFO+sample+signature==';
    const request = makeRequest([
      {
        text: '',
        type: ReasoningDetailType.Text,
        index: 0,
        format: 'anthropic-claude-v1',
        signature,
      },
      {
        text: '',
        type: ReasoningDetailType.Text,
        index: 0,
        format: 'anthropic-claude-v1',
        signature,
      },
    ]);

    fixOpenCodeDuplicateReasoning('anthropic/claude-opus-4.7', request, 'test-session');

    const details = getReasoningDetails(request);
    expect(details).toHaveLength(1);
    expect((details[0] as { signature: string }).signature).toBe(signature);
  });

  it('keeps reasoning items with distinct signatures', () => {
    const request = makeRequest([
      {
        text: '',
        type: ReasoningDetailType.Text,
        format: 'anthropic-claude-v1',
        signature: 'sig-a',
      },
      {
        text: '',
        type: ReasoningDetailType.Text,
        format: 'anthropic-claude-v1',
        signature: 'sig-b',
      },
    ]);

    fixOpenCodeDuplicateReasoning('anthropic/claude-opus-4.7', request, 'test-session');

    expect(getReasoningDetails(request)).toHaveLength(2);
  });

  it('deduplicates text reasoning items with identical text', () => {
    const request = makeRequest([
      {
        text: 'hello',
        type: ReasoningDetailType.Text,
        format: 'anthropic-claude-v1',
        signature: 'sig-a',
      },
      {
        text: 'hello',
        type: ReasoningDetailType.Text,
        format: 'anthropic-claude-v1',
        signature: 'sig-b',
      },
    ]);

    fixOpenCodeDuplicateReasoning('anthropic/claude-opus-4.7', request, 'test-session');

    expect(getReasoningDetails(request)).toHaveLength(1);
  });

  it('deduplicates encrypted reasoning items with identical data', () => {
    const request = makeRequest([
      { type: ReasoningDetailType.Encrypted, data: 'encrypted-blob' },
      { type: ReasoningDetailType.Encrypted, data: 'encrypted-blob' },
      { type: ReasoningDetailType.Encrypted, data: 'other-blob' },
    ]);

    fixOpenCodeDuplicateReasoning('anthropic/claude-opus-4.7', request, 'test-session');

    expect(getReasoningDetails(request)).toHaveLength(2);
  });

  it('drops anthropic text reasoning without signature', () => {
    const request = makeRequest([
      {
        text: 'hello',
        type: ReasoningDetailType.Text,
        format: 'anthropic-claude-v1',
      },
    ]);

    fixOpenCodeDuplicateReasoning('anthropic/claude-opus-4.7', request, 'test-session');

    expect(getReasoningDetails(request)).toHaveLength(0);
  });
});
