import { describe, expect, it, vi } from 'vitest';
import { writeClassifierMetricsDataPoint } from './classifier-analytics';
import type { ClassifierOutput } from './classifier-output';

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
        AUTO_ROUTING_CLASSIFIER_METRICS_V2: { writeDataPoint },
      },
      {
        status: 'classified',
        classifierModel: 'google/gemini-2.5-flash-lite',
        requestedModel: 'anthropic/claude-sonnet-4',
        classification,
        classifierDurationMs: 123.45,
        classifierCostCredits: 0.00000123,
      }
    );

    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['google/gemini-2.5-flash-lite'],
      blobs: [
        'google/gemini-2.5-flash-lite',
        'anthropic/claude-sonnet-4',
        'classified',
        'debugging',
        'test_repair',
        'medium',
        'medium',
        'code_change',
        '1',
      ],
      doubles: [123.45, 0.00000123, 0.74, 0],
    });
  });
});
