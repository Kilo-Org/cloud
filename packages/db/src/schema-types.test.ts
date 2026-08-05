import { describe, expect, it } from '@jest/globals';
import {
  CodeReviewCouncilConfigSchema,
  ModelsSchema,
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

describe('ModelsSchema', () => {
  it('preserves only supported reasoning metadata', () => {
    const result = ModelsSchema.parse({
      data: [
        {
          id: 'openai/gpt-5.2',
          name: 'OpenAI: GPT-5.2',
          reasoning: {
            mandatory: false,
            supported_efforts: ['high', 'medium', 'low', 'none'],
            default_enabled: true,
            default_effort: 'medium',
          },
        },
      ],
    });

    expect(result.data[0].reasoning).toEqual({
      mandatory: false,
      supported_efforts: ['high', 'medium', 'low', 'none'],
    });
  });

  it('allows reasoning metadata without supported efforts', () => {
    const result = ModelsSchema.parse({
      data: [
        {
          id: 'google/gemini-2.5-pro',
          name: 'Google: Gemini 2.5 Pro',
          reasoning: { mandatory: true },
        },
      ],
    });

    expect(result.data[0].reasoning).toEqual({ mandatory: true });
  });
});
