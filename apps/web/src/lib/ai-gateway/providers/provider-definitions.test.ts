import { describe, expect, test } from '@jest/globals';

import { OPENROUTER } from '@/lib/ai-gateway/providers/definitions/openrouter';
import { tryGetProviderById } from '@/lib/ai-gateway/providers/definitions/try-get-provider-by-id';

describe('tryGetProviderById', () => {
  test('resolves static provider definitions', () => {
    expect(tryGetProviderById('openrouter')).toBe(OPENROUTER);
  });

  test('does not claim dynamically constructed providers', () => {
    expect(tryGetProviderById('direct-byok')).toBeUndefined();
  });
});
