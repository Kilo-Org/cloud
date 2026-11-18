import { describe, expect, it } from '@jest/globals';
import type { CustomLlmDefinition } from '@kilocode/db/schema-types';
import { hasCustomLlmAccess } from './access';

const definition: CustomLlmDefinition = {
  internal_id: 'upstream-model',
  display_name: 'Private model',
  context_length: 128_000,
  max_completion_tokens: 4096,
  base_url: 'https://example.com/v1',
  organization_ids: ['00000000-0000-4000-8000-000000000101'],
  group_ids: ['00000000-0000-4000-8000-000000000001'],
};

describe('hasCustomLlmAccess', () => {
  it('allows organization-wide access without a matching group', () => {
    expect(hasCustomLlmAccess(definition, '00000000-0000-4000-8000-000000000101', [])).toBe(true);
  });

  it('allows access through a matching group when the organization is not allowed', () => {
    expect(
      hasCustomLlmAccess(definition, '00000000-0000-4000-8000-000000000102', [
        '00000000-0000-4000-8000-000000000001',
      ])
    ).toBe(true);
  });

  it('denies access when neither the organization nor a group matches', () => {
    expect(
      hasCustomLlmAccess(definition, '00000000-0000-4000-8000-000000000102', [
        '00000000-0000-4000-8000-000000000002',
      ])
    ).toBe(false);
  });
});
