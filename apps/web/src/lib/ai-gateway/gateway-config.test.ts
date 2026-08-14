import { describe, test, expect } from '@jest/globals';
import {
  GatewayRoutingConfigSchema,
  GatewayConfigSchema,
  GatewayConfigInputSchema,
  NOTE_MAX_LENGTH,
  RoutingPercentageSchema,
} from './gateway-config';

describe('RoutingPercentageSchema', () => {
  test.each([0, 0.001, 12.345, 99.9, 99.999, 100])('accepts %s', percentage => {
    expect(RoutingPercentageSchema.parse(percentage)).toBe(percentage);
  });

  test.each([-0.001, 12.3456, 100.001])('rejects %s', percentage => {
    expect(() => RoutingPercentageSchema.parse(percentage)).toThrow();
  });
});

describe('GatewayRoutingConfigSchema', () => {
  test('accepts a numeric percentage', () => {
    expect(GatewayRoutingConfigSchema.parse({ vercel_routing_percentage: 25 })).toEqual({
      vercel_routing_percentage: 25,
      vercel_routing_percentage_free: null,
      vercel_routing_opt_out_models: [],
      friendli_routing_percentage: null,
      perplexity_routing_percentage: null,
    });
  });

  test('accepts null (written when an admin clears the override)', () => {
    expect(GatewayRoutingConfigSchema.parse({ vercel_routing_percentage: null })).toEqual({
      vercel_routing_percentage: null,
      vercel_routing_percentage_free: null,
      vercel_routing_opt_out_models: [],
      friendli_routing_percentage: null,
      perplexity_routing_percentage: null,
    });
  });

  test('defaults the free percentage to null for pre-existing entries', () => {
    expect(GatewayRoutingConfigSchema.parse({ vercel_routing_percentage: 25 })).toEqual({
      vercel_routing_percentage: 25,
      vercel_routing_percentage_free: null,
      vercel_routing_opt_out_models: [],
      friendli_routing_percentage: null,
      perplexity_routing_percentage: null,
    });
  });

  test('accepts a separate free percentage', () => {
    expect(
      GatewayRoutingConfigSchema.parse({
        vercel_routing_percentage: 25,
        vercel_routing_percentage_free: 80,
      })
    ).toEqual({
      vercel_routing_percentage: 25,
      vercel_routing_percentage_free: 80,
      vercel_routing_opt_out_models: [],
      friendli_routing_percentage: null,
      perplexity_routing_percentage: null,
    });
  });

  test('accepts model opt-outs', () => {
    expect(
      GatewayRoutingConfigSchema.parse({
        vercel_routing_percentage: 25,
        vercel_routing_opt_out_models: ['moonshotai/kimi-k3'],
      })
    ).toEqual({
      vercel_routing_percentage: 25,
      vercel_routing_percentage_free: null,
      vercel_routing_opt_out_models: ['moonshotai/kimi-k3'],
      friendli_routing_percentage: null,
      perplexity_routing_percentage: null,
    });
  });

  test('accepts Friendli and Perplexity percentages', () => {
    expect(
      GatewayRoutingConfigSchema.parse({
        vercel_routing_percentage: 25,
        friendli_routing_percentage: 10,
        perplexity_routing_percentage: 20,
      })
    ).toEqual({
      vercel_routing_percentage: 25,
      vercel_routing_percentage_free: null,
      vercel_routing_opt_out_models: [],
      friendli_routing_percentage: 10,
      perplexity_routing_percentage: 20,
    });
  });

  test('rejects out-of-range values', () => {
    expect(() => GatewayRoutingConfigSchema.parse({ vercel_routing_percentage: 101 })).toThrow();
    expect(() => GatewayRoutingConfigSchema.parse({ vercel_routing_percentage: -1 })).toThrow();
    expect(() =>
      GatewayRoutingConfigSchema.parse({
        vercel_routing_percentage: 25,
        vercel_routing_percentage_free: 101,
      })
    ).toThrow();
  });
});

describe('GatewayConfigSchema', () => {
  test('defaults note to null for pre-existing Redis entries without the field', () => {
    const parsed = GatewayConfigSchema.parse({
      vercel_routing_percentage: 25,
      updated_at: '2026-01-01T00:00:00.000Z',
      updated_by: 'u1',
      updated_by_email: 'a@example.com',
    });
    expect(parsed.note).toBeNull();
    expect(parsed.vercel_routing_opt_out_models).toEqual([]);
    expect(parsed.friendli_routing_percentage).toBeNull();
    expect(parsed.perplexity_routing_percentage).toBeNull();
  });

  test('round-trips a note', () => {
    const parsed = GatewayConfigSchema.parse({
      vercel_routing_percentage: 25,
      updated_at: '2026-01-01T00:00:00.000Z',
      updated_by: 'u1',
      updated_by_email: 'a@example.com',
      note: 'Ramping down Vercel due to incident.',
    });
    expect(parsed.note).toBe('Ramping down Vercel due to incident.');
  });
});

describe('GatewayConfigInputSchema', () => {
  test('accepts a note alongside a percentage', () => {
    expect(
      GatewayConfigInputSchema.parse({
        vercel_routing_percentage: 75,
        vercel_routing_percentage_free: 60,
        vercel_routing_opt_out_models: ['moonshotai/kimi-k3'],
        friendli_routing_percentage: 10,
        perplexity_routing_percentage: 20,
        note: 'Rollout stable',
      })
    ).toEqual({
      vercel_routing_percentage: 75,
      vercel_routing_percentage_free: 60,
      vercel_routing_opt_out_models: ['moonshotai/kimi-k3'],
      friendli_routing_percentage: 10,
      perplexity_routing_percentage: 20,
      note: 'Rollout stable',
    });
  });

  test('accepts a null note', () => {
    expect(
      GatewayConfigInputSchema.parse({
        vercel_routing_percentage: null,
        vercel_routing_percentage_free: null,
        vercel_routing_opt_out_models: [],
        friendli_routing_percentage: null,
        perplexity_routing_percentage: null,
        note: null,
      })
    ).toEqual({
      vercel_routing_percentage: null,
      vercel_routing_percentage_free: null,
      vercel_routing_opt_out_models: [],
      friendli_routing_percentage: null,
      perplexity_routing_percentage: null,
      note: null,
    });
  });

  test('rejects notes longer than the maximum', () => {
    expect(() =>
      GatewayConfigInputSchema.parse({
        vercel_routing_percentage: 50,
        vercel_routing_percentage_free: 50,
        vercel_routing_opt_out_models: [],
        friendli_routing_percentage: 0,
        perplexity_routing_percentage: 0,
        note: 'x'.repeat(NOTE_MAX_LENGTH + 1),
      })
    ).toThrow();
  });
});
