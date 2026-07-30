import type { CustomLlmDefinition } from '@kilocode/db/schema-types';
import { canAccessCustomLlm } from './access';

const definition: CustomLlmDefinition = {
  internal_id: 'upstream-model',
  display_name: 'Custom model',
  context_length: 128_000,
  max_completion_tokens: 8_192,
  base_url: 'https://example.com/v1',
  api_key: 'test-key',
  organization_ids: ['allowed-organization'],
};

describe('canAccessCustomLlm', () => {
  it('requires the organization to be allowed', () => {
    expect(canAccessCustomLlm(definition, 'other-organization', '203.0.113.10')).toBe(false);
  });

  it('allows any client IP when no IP allow list is configured', () => {
    expect(canAccessCustomLlm(definition, 'allowed-organization', null)).toBe(true);
    expect(canAccessCustomLlm(definition, 'allowed-organization', '203.0.113.10')).toBe(true);
  });

  it('requires the client IP to be in a configured allow list', () => {
    const restrictedDefinition = {
      ...definition,
      ip_allow_list: ['203.0.113.10', '2001:db8::1'],
    } satisfies CustomLlmDefinition;

    expect(canAccessCustomLlm(restrictedDefinition, 'allowed-organization', null)).toBe(false);
    expect(canAccessCustomLlm(restrictedDefinition, 'allowed-organization', '203.0.113.11')).toBe(
      false
    );
    expect(canAccessCustomLlm(restrictedDefinition, 'allowed-organization', '203.0.113.10')).toBe(
      true
    );
    expect(canAccessCustomLlm(restrictedDefinition, 'allowed-organization', '2001:db8::1')).toBe(
      true
    );
    expect(
      canAccessCustomLlm(restrictedDefinition, 'allowed-organization', '2001:0db8:0:0:0:0:0:1')
    ).toBe(true);
    expect(
      canAccessCustomLlm(restrictedDefinition, 'allowed-organization', '::ffff:203.0.113.10')
    ).toBe(true);
  });

  it('denies every client IP when the configured allow list is empty', () => {
    const restrictedDefinition = {
      ...definition,
      ip_allow_list: [],
    } satisfies CustomLlmDefinition;

    expect(canAccessCustomLlm(restrictedDefinition, 'allowed-organization', '203.0.113.10')).toBe(
      false
    );
  });
});
