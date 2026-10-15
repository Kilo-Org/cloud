import { describe, test, expect } from '@jest/globals';
import {
  GatewayRoutingConfigSchema,
  GatewayConfigSchema,
  GatewayConfigInputSchema,
  NOTE_MAX_LENGTH,
} from './gateway-config';

describe('GatewayRoutingConfigSchema', () => {
  test('defaults model opt-outs to an empty list', () => {
    expect(GatewayRoutingConfigSchema.parse({})).toEqual({ vercel_routing_opt_out_models: [] });
  });

  test('accepts model opt-outs', () => {
    expect(
      GatewayRoutingConfigSchema.parse({ vercel_routing_opt_out_models: ['moonshotai/kimi-k3'] })
    ).toEqual({ vercel_routing_opt_out_models: ['moonshotai/kimi-k3'] });
  });
});

describe('GatewayConfigSchema', () => {
  test('defaults note and opt-outs for saved entries without the fields', () => {
    const parsed = GatewayConfigSchema.parse({
      updated_at: '2026-01-01T00:00:00.000Z',
      updated_by: 'u1',
      updated_by_email: 'a@example.com',
    });
    expect(parsed.note).toBeNull();
    expect(parsed.vercel_routing_opt_out_models).toEqual([]);
  });

  test('round-trips a note', () => {
    const parsed = GatewayConfigSchema.parse({
      updated_at: '2026-01-01T00:00:00.000Z',
      updated_by: 'u1',
      updated_by_email: 'a@example.com',
      note: 'Opting out a model due to an incident.',
    });
    expect(parsed.note).toBe('Opting out a model due to an incident.');
  });
});

describe('saved gateway configuration compatibility', () => {
  test.each([
    { name: 'runtime routing', schema: GatewayRoutingConfigSchema },
    { name: 'admin configuration', schema: GatewayConfigSchema },
  ])('$name drops obsolete routing percentages from saved JSON', ({ schema }) => {
    const savedJson = JSON.stringify({
      vercel_routing_percentage: 25,
      vercel_routing_percentage_free: 80,
      vercel_routing_opt_out_models: ['moonshotai/kimi-k3'],
      friendli_routing_percentage: 10,
      perplexity_routing_percentage: 12.345,
      updated_at: '2026-01-01T00:00:00.000Z',
      updated_by: 'u1',
      updated_by_email: 'a@example.com',
      note: 'Existing routing overrides',
    });

    const parsed = schema.parse(JSON.parse(savedJson));

    expect(parsed).toMatchObject({ vercel_routing_opt_out_models: ['moonshotai/kimi-k3'] });
    for (const obsolete of [
      'vercel_routing_percentage',
      'vercel_routing_percentage_free',
      'friendli_routing_percentage',
      'perplexity_routing_percentage',
    ]) {
      expect(parsed).not.toHaveProperty(obsolete);
    }
  });
});

describe('GatewayConfigInputSchema', () => {
  test('accepts opt-outs with a note', () => {
    expect(
      GatewayConfigInputSchema.parse({
        vercel_routing_opt_out_models: ['moonshotai/kimi-k3'],
        note: 'Rollout stable',
      })
    ).toEqual({ vercel_routing_opt_out_models: ['moonshotai/kimi-k3'], note: 'Rollout stable' });
  });

  test('accepts a null note', () => {
    expect(
      GatewayConfigInputSchema.parse({ vercel_routing_opt_out_models: [], note: null })
    ).toEqual({ vercel_routing_opt_out_models: [], note: null });
  });

  test('rejects notes longer than the maximum', () => {
    expect(() =>
      GatewayConfigInputSchema.parse({
        vercel_routing_opt_out_models: [],
        note: 'x'.repeat(NOTE_MAX_LENGTH + 1),
      })
    ).toThrow();
  });
});
