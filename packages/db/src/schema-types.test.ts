import { describe, expect, it } from '@jest/globals';
import {
  CodeReviewCouncilConfigSchema,
  CustomLlmDefinitionSchema,
  OrganizationSettingsSchema,
} from './schema-types';

describe('CodeReviewCouncilConfigSchema', () => {
  const specialist = (id: string) => ({
    id,
    role: 'security' as const,
    name: 'Security',
    enabled: true,
    required: false,
    lens: 'security concerns',
  });

  it('accepts a council with unique specialist ids', () => {
    const result = CodeReviewCouncilConfigSchema.safeParse({
      specialists: [specialist('security'), specialist('performance')],
    });
    expect(result.success).toBe(true);
  });

  it('rejects duplicate specialist ids (a specialist must not vote twice)', () => {
    const result = CodeReviewCouncilConfigSchema.safeParse({
      specialists: [specialist('security'), specialist('security')],
    });
    expect(result.success).toBe(false);
  });
});

describe('OrganizationSettingsSchema org_auto_model', () => {
  it('accepts bounded route maps and a fallback model', () => {
    const result = OrganizationSettingsSchema.safeParse({
      org_auto_model: {
        routes: {
          code: 'anthropic/claude-sonnet-4.5',
          plan: 'kilo-auto/frontier',
        },
        fallback_model: 'kilo-auto/balanced',
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects Organization Auto self-targets', () => {
    const result = OrganizationSettingsSchema.safeParse({
      org_auto_model: {
        routes: { code: 'kilo-auto/org' },
        fallback_model: 'kilo-auto/balanced',
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects route maps with more than 100 routes', () => {
    const routes = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`mode-${index}`, 'kilo-auto/balanced'])
    );
    const result = OrganizationSettingsSchema.safeParse({
      org_auto_model: {
        routes,
        fallback_model: 'kilo-auto/balanced',
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('CustomLlmDefinitionSchema ip_allow_list', () => {
  const definition = {
    internal_id: 'upstream-model',
    display_name: 'Custom model',
    context_length: 128_000,
    max_completion_tokens: 8_192,
    base_url: 'https://example.com/v1',
    api_key: 'test-key',
    organization_ids: ['organization-id'],
  };

  it('accepts definitions without an IP allow list', () => {
    expect(CustomLlmDefinitionSchema.safeParse(definition).success).toBe(true);
  });

  it('accepts IPv4 and IPv6 addresses', () => {
    const result = CustomLlmDefinitionSchema.safeParse({
      ...definition,
      ip_allow_list: ['203.0.113.10', '2001:db8::1'],
    });

    expect(result.success).toBe(true);
  });

  it('rejects invalid IP addresses', () => {
    const result = CustomLlmDefinitionSchema.safeParse({
      ...definition,
      ip_allow_list: ['not-an-ip'],
    });

    expect(result.success).toBe(false);
  });

  it('rejects CIDR ranges', () => {
    const result = CustomLlmDefinitionSchema.safeParse({
      ...definition,
      ip_allow_list: ['203.0.113.0/24'],
    });

    expect(result.success).toBe(false);
  });
});
