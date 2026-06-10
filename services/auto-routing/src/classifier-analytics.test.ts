import { describe, expect, it, vi } from 'vitest';
import { writeClassifierMetricsDataPoint } from './classifier-analytics';
import type { NormalizedClassifierInput } from './classifier-input';
import type { ClassifierOutput } from './classification';

const input = {
  apiKind: 'chat_completions',
  requestedModel: 'anthropic/claude-sonnet-4',
  systemPromptPrefix: '',
  userPromptPrefix: 'Fix the failing test.',
  messageCount: 2,
  hasTools: true,
  stream: false,
  providerHints: {
    provider: null,
    providerOptions: null,
  },
} satisfies NormalizedClassifierInput;

const classification = {
  taskType: 'debugging',
  subtaskType: 'test_repair',
  contextComplexity: 'medium',
  reasoningComplexity: 'medium',
  riskLevel: 'medium',
  executionMode: 'code_change',
  requiresTools: true,
  confidence: 0.74,
} satisfies ClassifierOutput;

describe('classifier analytics', () => {
  it('writes classifier duration and OpenRouter credit cost to the numeric slots', () => {
    const writeDataPoint = vi.fn();

    writeClassifierMetricsDataPoint(
      {
        AUTO_ROUTING_CLASSIFIER_METRICS: { writeDataPoint },
      },
      {
        status: 'classified',
        classifierModel: 'google/gemma-4-31b-it',
        input,
        classification,
        sessionId: 'task-123',
        classifierDurationMs: 123.45,
        classifierCostCredits: 0.00000123,
        bodyBytes: 456,
      }
    );

    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['google/gemma-4-31b-it'],
      blobs: [
        'google/gemma-4-31b-it',
        'anthropic/claude-sonnet-4',
        'chat_completions',
        'classified',
        'debugging',
        'test_repair',
        'medium',
        'medium',
        'code_change',
        '1',
        '0.6-0.8',
        'task-123',
      ],
      doubles: [123.45, 0.00000123, 0.74, 2, 1, 456],
    });
  });
});
