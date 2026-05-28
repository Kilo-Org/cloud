import { describe, expect, test } from '@jest/globals';
import {
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  CLAUDE_SONNET_CURRENT_MODEL_ID,
} from '@/lib/ai-gateway/providers/anthropic.constants';
import { qwen36_plus_model, qwen37_max_model } from '@/lib/ai-gateway/providers/qwen';
import {
  BALANCED_CODE_MODEL,
  BALANCED_MODE_TO_MODEL,
  FRONTIER_CODE_MODEL,
  FRONTIER_MODE_TO_MODEL,
  modeSchema,
} from '@/lib/ai-gateway/auto-model';

describe('Auto Balanced model routing', () => {
  test('uses Qwen3.7 Max in modes where Auto Frontier uses Claude Opus', () => {
    for (const mode of modeSchema.options) {
      const frontierModel = FRONTIER_MODE_TO_MODEL[mode].model;
      const balancedModel = BALANCED_MODE_TO_MODEL[mode].model;

      if (frontierModel === CLAUDE_OPUS_CURRENT_MODEL_ID) {
        expect(balancedModel).toBe(qwen37_max_model.public_id);
      } else {
        expect(frontierModel).toBe(CLAUDE_SONNET_CURRENT_MODEL_ID);
        expect(balancedModel).toBe(qwen36_plus_model.public_id);
      }
    }
  });

  test('keeps Qwen3.6 Plus for the Sonnet-aligned default route', () => {
    expect(FRONTIER_CODE_MODEL.model).toBe(CLAUDE_SONNET_CURRENT_MODEL_ID);
    expect(BALANCED_CODE_MODEL.model).toBe(qwen36_plus_model.public_id);
  });
});
