import { describe, expect, it } from '@jest/globals';
import {
  CodeReviewCouncilConfigSchema,
  CustomLlmDefinitionSchema,
  EnkryptInputGuardrailSettingsSchema,
  ModelsSchema,
  VercelModelsSchema,
  OpenRouterPricing,
  OpenRouterProvider,
  ReasoningDetailsTransformSchema,
  OrganizationBrowserAllowedOriginSchema,
  OrganizationSettingsSchema,
  normalizeOrganizationBrowserOrigin,
} from './schema-types';
import type { GatewayModel } from './schema-types';

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

describe('OpenRouterProvider', () => {
  it('keeps terms and privacy links from the OpenRouter provider catalog', () => {
    const parsed = OpenRouterProvider.parse({
      name: 'Anthropic',
      displayName: 'Anthropic',
      slug: 'anthropic',
      headquarters: 'US',
      dataPolicy: {
        training: false,
        retainsPrompts: true,
        canPublish: false,
        termsOfServiceURL: 'https://www.anthropic.com/legal/commercial-terms',
        privacyPolicyURL: 'https://www.anthropic.com/legal/privacy',
      },
    });

    expect(parsed.dataPolicy.termsOfServiceURL).toBe(
      'https://www.anthropic.com/legal/commercial-terms'
    );
    expect(parsed.dataPolicy.privacyPolicyURL).toBe('https://www.anthropic.com/legal/privacy');
    expect(parsed.headquarters).toBe('US');
  });
});

describe('EnkryptInputGuardrailSettingsSchema', () => {
  it.each([false, true])('strips legacy scan_tool_results: %s', scan_tool_results => {
    const settings = {
      enabled: true,
      detectors: { injection_attack: { enabled: true, action: 'block' } },
      group_id: '00000000-0000-4000-8000-000000000003',
    };

    const parsed = EnkryptInputGuardrailSettingsSchema.parse({ ...settings, scan_tool_results });

    expect(parsed).toEqual(settings);
    expect(parsed).not.toHaveProperty('scan_tool_results');
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

describe('VercelModelsSchema', () => {
  it('drops malformed description fields without rejecting the model', () => {
    const result = VercelModelsSchema.parse({
      data: [
        {
          id: 'vendor/model',
          name: 'Model',
          type: 'language',
          context_window: '128k',
          modalities: { input: ['text'] },
          pricing: { input: 1 },
          deprecated_at: 'soon',
          reasoning_options: [{ type: 'effort', values: ['low'] }, { values: ['high'] }],
        },
      ],
    });

    expect(result.data[0]).toEqual({ id: 'vendor/model', name: 'Model', type: 'language' });
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

  it('drops invalid reasoning metadata', () => {
    const result = ModelsSchema.parse({
      data: [
        {
          id: 'example/future-effort',
          name: 'Future Effort',
          reasoning: {
            mandatory: false,
            supported_efforts: ['future'],
          },
        },
      ],
    });

    expect(result.data[0].reasoning).toBeUndefined();
  });

  it('preserves an OpenRouter alias target slug', () => {
    const result = ModelsSchema.parse({
      data: [
        {
          id: '~deepseek/deepseek-pro-latest',
          name: 'DeepSeek: DeepSeek V4 Pro 0813',
          alias_target: {
            name: 'DeepSeek: DeepSeek V4 Pro 0813',
            slug: 'deepseek/deepseek-v4-pro-0813',
          },
        },
      ],
    });

    expect(result.data[0].alias_target).toEqual({
      slug: 'deepseek/deepseek-v4-pro-0813',
    });
  });

  it('drops malformed optional alias metadata', () => {
    const result = ModelsSchema.parse({
      data: [
        {
          id: 'vendor/model',
          name: 'Vendor Model',
          alias_target: { slug: '' },
        },
      ],
    });

    expect(result.data[0].alias_target).toBeUndefined();
  });

  it('preserves only OpenRouter output modalities from the architecture', () => {
    const result = ModelsSchema.parse({
      data: [
        {
          id: 'typesafe/jev-1.13',
          name: 'TypeSafe: Jev 1.13',
          architecture: {
            modality: 'text->decisions',
            input_modalities: ['text'],
            output_modalities: ['decisions'],
            tokenizer: 'Other',
          },
        },
        { id: 'vendor/model', name: 'Vendor Model', architecture: { output_modalities: 'text' } },
      ],
    });

    expect(result.data.map(model => model.architecture)).toEqual([
      { output_modalities: ['decisions'] },
      undefined,
    ]);
  });

  it('preserves Vercel model types and drops unknown ones', () => {
    const types = [
      'language',
      'embedding',
      'image',
      'video',
      'speech',
      'transcription',
      'reranking',
      'realtime',
      'evaluation',
    ];
    const result = ModelsSchema.parse({
      data: [...types, 'hologram'].map(type => ({ id: `vendor/${type}`, name: type, type })),
    });

    expect(result.data.map(model => model.type)).toEqual([...types, undefined]);
  });

  it('includes model reasoning metadata', () => {
    const reasoning = {
      mandatory: false,
      supported_efforts: ['high', 'medium', 'low', 'none'],
    } satisfies GatewayModel['reasoning'];

    const result = ModelsSchema.parse({
      data: [{ id: 'openai/gpt-5.2', name: 'OpenAI: GPT-5.2', reasoning }],
    });

    expect(result.data[0].reasoning).toEqual(reasoning);
  });
});

describe('OpenRouterPricing', () => {
  it('preserves discounts used to calculate display pricing', () => {
    const pricing = OpenRouterPricing.parse({
      prompt: '0.000000435',
      completion: '0.00000087',
      discount: 0.5,
    });

    expect(pricing.discount).toBe(0.5);
  });
});

describe('OrganizationBrowserAllowedOriginSchema', () => {
  it.each([
    'https://example.com',
    'https://example.com/',
    'http://example.com',
    'http://localhost:3000',
    'https://app.example.com:8443',
  ])('accepts the origin %s', origin => {
    expect(OrganizationBrowserAllowedOriginSchema.safeParse(origin).success).toBe(true);
  });

  it.each([
    'example.com',
    'https://example.com/path',
    'https://example.com?query=1',
    'https://example.com#section',
    'https://user:password@example.com',
    'ftp://example.com',
    'https://',
    '',
  ])('rejects %s', origin => {
    expect(OrganizationBrowserAllowedOriginSchema.safeParse(origin).success).toBe(false);
  });

  it('normalizes a trailing slash to the bare origin', () => {
    expect(normalizeOrganizationBrowserOrigin('https://Example.com:443/')).toBe(
      'https://example.com'
    );
    expect(normalizeOrganizationBrowserOrigin('https://example.com/path')).toBeNull();
  });
});

describe('OrganizationSettingsSchema browser control', () => {
  it('keeps the browser control policy', () => {
    const parsed = OrganizationSettingsSchema.parse({
      browserControl: 'playwright_only',
      browserAllowedOrigins: ['https://example.com', 'http://localhost:3000'],
    });

    expect(parsed.browserControl).toBe('playwright_only');
    expect(parsed.browserAllowedOrigins).toEqual(['https://example.com', 'http://localhost:3000']);
  });

  it('rejects an unknown browser control mode', () => {
    const parsed = OrganizationSettingsSchema.safeParse({ browserControl: 'ask' });
    expect(parsed.success).toBe(false);
  });

  it('rejects an allowed origin with a path', () => {
    const parsed = OrganizationSettingsSchema.safeParse({
      browserAllowedOrigins: ['https://example.com/checkout'],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('CustomLlmDefinitionSchema partner', () => {
  const baseDefinition = {
    internal_id: 'upstream-model',
    display_name: 'Partner model',
    context_length: 128_000,
    max_completion_tokens: 4096,
    base_url: 'https://partner.example.com/v1',
  };
  const pricing = [
    {
      start_context_length: 0,
      pricing: {
        prompt_per_million: 1,
        completion_per_million: 2,
        input_cache_read_per_million: null,
        input_cache_write_per_million: null,
      },
    },
  ];
  const partner = { inference_provider: 'acme-ai' };
  const uuid = '00000000-0000-4000-8000-000000000123';

  function issuePaths(definition: Record<string, unknown>) {
    const result = CustomLlmDefinitionSchema.safeParse({ ...baseDefinition, ...definition });
    return result.success ? null : result.error.issues.map(issue => issue.path.join('.'));
  }

  it('parses a partner definition with pricing', () => {
    const result = CustomLlmDefinitionSchema.safeParse({ ...baseDefinition, partner, pricing });

    expect(result.success).toBe(true);
    expect(result.data?.partner).toEqual(partner);
  });

  it('parses a partner definition with a reasoning details transform and country deny list', () => {
    const result = CustomLlmDefinitionSchema.safeParse({
      ...baseDefinition,
      partner,
      pricing,
      may_train_on_prompts: false,
      country_deny_list: ['CU'],
      reasoning_details_transform: 'mistral-thinking',
    });

    expect(result.success).toBe(true);
  });

  it('requires pricing', () => {
    expect(issuePaths({ partner })).toEqual(['pricing']);
  });

  it.each([
    ['public', { public: { inference_providers: ['acme-ai'], description: 'A public model' } }],
    ['organization_ids', { organization_ids: [uuid] }],
    ['organization_ids', { organization_ids: [] }],
    ['group_ids', { group_ids: [uuid] }],
  ])('rejects %s', (key, extra) => {
    expect(issuePaths({ partner, pricing, ...extra })).toEqual([key]);
  });

  it('rejects an inference provider that is not a lowercase slug', () => {
    expect(issuePaths({ partner: { inference_provider: 'Acme AI' }, pricing })).toEqual([
      'partner.inference_provider',
    ]);
  });

  it('keeps accepting a definition without a partner or pricing', () => {
    expect(CustomLlmDefinitionSchema.safeParse(baseDefinition).success).toBe(true);
  });
});

describe('ReasoningDetailsTransformSchema', () => {
  it('accepts mistral-thinking', () => {
    expect(ReasoningDetailsTransformSchema.parse('mistral-thinking')).toBe('mistral-thinking');
  });
});
