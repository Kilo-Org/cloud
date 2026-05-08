import { describe, test, expect } from '@jest/globals';
import {
  GatewayPercentageSchema,
  GatewayConfigSchema,
  GatewayConfigInputSchema,
  NOTE_MAX_LENGTH,
} from './gateway-config';

describe('GatewayPercentageSchema', () => {
  test('accepts a numeric percentage', () => {
    expect(GatewayPercentageSchema.parse({ vercel_routing_percentage: 25 })).toEqual({
      vercel_routing_percentage: 25,
    });
  });

  test('accepts null (written when an admin clears the override)', () => {
    expect(GatewayPercentageSchema.parse({ vercel_routing_percentage: null })).toEqual({
      vercel_routing_percentage: null,
    });
  });

  test('rejects out-of-range values', () => {
    expect(() => GatewayPercentageSchema.parse({ vercel_routing_percentage: 101 })).toThrow();
    expect(() => GatewayPercentageSchema.parse({ vercel_routing_percentage: -1 })).toThrow();
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
      GatewayConfigInputSchema.parse({ vercel_routing_percentage: 75, note: 'Rollout stable' })
    ).toEqual({ vercel_routing_percentage: 75, note: 'Rollout stable' });
  });

  test('accepts a null note', () => {
    expect(GatewayConfigInputSchema.parse({ vercel_routing_percentage: null, note: null })).toEqual(
      { vercel_routing_percentage: null, note: null }
    );
  });

  test('rejects notes longer than the maximum', () => {
    expect(() =>
      GatewayConfigInputSchema.parse({
        vercel_routing_percentage: 50,
        note: 'x'.repeat(NOTE_MAX_LENGTH + 1),
      })
    ).toThrow();
  });
});
