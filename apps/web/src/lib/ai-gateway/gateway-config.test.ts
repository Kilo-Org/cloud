import { describe, test, expect } from '@jest/globals';
import { GatewayPercentageSchema } from './gateway-config';

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
