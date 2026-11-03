import { describe, test, expect } from '@jest/globals';
import {
  GatewayRoutingConfigSchema,
  GatewayConfigSchema,
  GatewayConfigInputSchema,
  NOTE_MAX_LENGTH,
  VERCEL_ROUTING_OPT_OUT_MODEL_MAX_LENGTH,
  VERCEL_ROUTING_OPT_OUT_MODELS_MAX_COUNT,
} from './gateway-config';

describe('GatewayRoutingConfigSchema', () => {
  test('defaults Vercel routing to on for an empty configuration', () => {
    expect(GatewayRoutingConfigSchema.parse({})).toEqual({
      vercel_routing_enabled: true,
      vercel_routing_opt_out_models: [],
    });
  });

  test('accepts Vercel routing switched off', () => {
    expect(GatewayRoutingConfigSchema.parse({ vercel_routing_enabled: false })).toEqual({
      vercel_routing_enabled: false,
      vercel_routing_opt_out_models: [],
    });
  });

  test('accepts model opt-outs', () => {
    expect(
      GatewayRoutingConfigSchema.parse({
        vercel_routing_enabled: true,
        vercel_routing_opt_out_models: ['moonshotai/kimi-k3'],
      })
    ).toEqual({
      vercel_routing_enabled: true,
      vercel_routing_opt_out_models: ['moonshotai/kimi-k3'],
    });
  });

  test('rejects a non-boolean switch value', () => {
    expect(() => GatewayRoutingConfigSchema.parse({ vercel_routing_enabled: 50 })).toThrow();
  });
});

describe('GatewayConfigSchema', () => {
  test('defaults note to null for saved entries without the field', () => {
    const parsed = GatewayConfigSchema.parse({
      vercel_routing_enabled: true,
      updated_at: '2026-01-01T00:00:00.000Z',
      updated_by: 'u1',
      updated_by_email: 'a@example.com',
    });
    expect(parsed.note).toBeNull();
    expect(parsed.vercel_routing_opt_out_models).toEqual([]);
  });

  test('round-trips a note', () => {
    const parsed = GatewayConfigSchema.parse({
      vercel_routing_enabled: false,
      updated_at: '2026-01-01T00:00:00.000Z',
      updated_by: 'u1',
      updated_by_email: 'a@example.com',
      note: 'Disabling Vercel due to incident.',
    });
    expect(parsed.note).toBe('Disabling Vercel due to incident.');
  });
});

describe('saved gateway configuration compatibility', () => {
  test.each([
    { name: 'runtime routing', schema: GatewayRoutingConfigSchema },
    { name: 'admin configuration', schema: GatewayConfigSchema },
  ])(
    '$name turns Vercel routing on and keeps opt-outs for saved percentage configurations',
    ({ schema }) => {
      const savedJson = JSON.stringify({
        vercel_routing_percentage: 0,
        vercel_routing_percentage_free: 0,
        vercel_routing_opt_out_models: ['moonshotai/kimi-k3'],
        friendli_routing_percentage: 10,
        updated_at: '2026-01-01T00:00:00.000Z',
        updated_by: 'u1',
        updated_by_email: 'a@example.com',
        note: 'Existing routing overrides',
      });

      const parsed = schema.parse(JSON.parse(savedJson));

      expect(parsed).toMatchObject({
        vercel_routing_enabled: true,
        vercel_routing_opt_out_models: ['moonshotai/kimi-k3'],
      });
      expect(parsed).not.toHaveProperty('vercel_routing_percentage');
      expect(parsed).not.toHaveProperty('vercel_routing_percentage_free');
      expect(parsed).not.toHaveProperty('friendli_routing_percentage');
    }
  );
});

describe('GatewayConfigInputSchema', () => {
  test('accepts a note alongside the switch', () => {
    expect(
      GatewayConfigInputSchema.parse({
        vercel_routing_enabled: true,
        vercel_routing_opt_out_models: ['moonshotai/kimi-k3'],
        note: 'Rollout stable',
      })
    ).toEqual({
      vercel_routing_enabled: true,
      vercel_routing_opt_out_models: ['moonshotai/kimi-k3'],
      note: 'Rollout stable',
    });
  });

  test('accepts a null note', () => {
    expect(
      GatewayConfigInputSchema.parse({
        vercel_routing_enabled: false,
        vercel_routing_opt_out_models: [],
        note: null,
      })
    ).toEqual({
      vercel_routing_enabled: false,
      vercel_routing_opt_out_models: [],
      note: null,
    });
  });

  test('requires the switch value', () => {
    expect(() =>
      GatewayConfigInputSchema.parse({
        vercel_routing_opt_out_models: [],
        note: null,
      })
    ).toThrow();
  });

  test('rejects notes longer than the maximum', () => {
    expect(() =>
      GatewayConfigInputSchema.parse({
        vercel_routing_enabled: true,
        vercel_routing_opt_out_models: [],
        note: 'x'.repeat(NOTE_MAX_LENGTH + 1),
      })
    ).toThrow();
  });

  test.each(['', '   ', '\t'])('rejects the blank opt-out entry %p', entry => {
    expect(() =>
      GatewayConfigInputSchema.parse({
        vercel_routing_enabled: true,
        vercel_routing_opt_out_models: ['moonshotai/kimi-k3', entry],
        note: null,
      })
    ).toThrow();
  });

  test('rejects an opt-out entry longer than the maximum', () => {
    expect(() =>
      GatewayConfigInputSchema.parse({
        vercel_routing_enabled: true,
        vercel_routing_opt_out_models: ['x'.repeat(VERCEL_ROUTING_OPT_OUT_MODEL_MAX_LENGTH + 1)],
        note: null,
      })
    ).toThrow();
  });

  test('accepts an opt-out entry at the maximum length', () => {
    const model = 'x'.repeat(VERCEL_ROUTING_OPT_OUT_MODEL_MAX_LENGTH);
    expect(
      GatewayConfigInputSchema.parse({
        vercel_routing_enabled: true,
        vercel_routing_opt_out_models: [model],
        note: null,
      }).vercel_routing_opt_out_models
    ).toEqual([model]);
  });

  test('rejects more opt-out entries than the maximum count', () => {
    const models = Array.from(
      { length: VERCEL_ROUTING_OPT_OUT_MODELS_MAX_COUNT + 1 },
      (_, index) => `provider/model-${index}`
    );
    expect(() =>
      GatewayConfigInputSchema.parse({
        vercel_routing_enabled: true,
        vercel_routing_opt_out_models: models,
        note: null,
      })
    ).toThrow();
  });

  test('trims, lowercases, and collapses duplicate opt-out entries', () => {
    const parsed = GatewayConfigInputSchema.parse({
      vercel_routing_enabled: true,
      vercel_routing_opt_out_models: [
        '  MoonshotAI/Kimi-K3  ',
        'moonshotai/kimi-k3',
        'provider/model-b',
        'PROVIDER/MODEL-B',
      ],
      note: null,
    });
    expect(parsed.vercel_routing_opt_out_models).toEqual([
      'moonshotai/kimi-k3',
      'provider/model-b',
    ]);
  });

  test('round-trips an accepted input through the stored-config and hot-path schemas', () => {
    const input = GatewayConfigInputSchema.parse({
      vercel_routing_enabled: false,
      vercel_routing_opt_out_models: [' MoonshotAI/Kimi-K3 ', 'moonshotai/kimi-k3', 'openai/gpt-6'],
      note: 'Holding opt-outs',
    });
    const storedJson = JSON.stringify({
      vercel_routing_enabled: input.vercel_routing_enabled,
      vercel_routing_opt_out_models: input.vercel_routing_opt_out_models,
      updated_at: '2026-01-01T00:00:00.000Z',
      updated_by: 'u1',
      updated_by_email: 'a@example.com',
      note: input.note,
    });

    expect(GatewayConfigSchema.parse(JSON.parse(storedJson)).vercel_routing_opt_out_models).toEqual(
      ['moonshotai/kimi-k3', 'openai/gpt-6']
    );
    expect(
      GatewayRoutingConfigSchema.parse(JSON.parse(storedJson)).vercel_routing_opt_out_models
    ).toEqual(['moonshotai/kimi-k3', 'openai/gpt-6']);
  });
});
