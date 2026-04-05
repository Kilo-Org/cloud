import { describe, expect, it } from 'vitest';
import { PORT_RANGE_MAX, PORT_RANGE_MIN, randomPort } from './ports.js';

describe('port constants', () => {
  it('PORT_RANGE_MIN is 10000', () => {
    expect(PORT_RANGE_MIN).toBe(10000);
  });

  it('PORT_RANGE_MAX is 60000', () => {
    expect(PORT_RANGE_MAX).toBe(60000);
  });
});

describe('randomPort', () => {
  it('returns a number within [PORT_RANGE_MIN, PORT_RANGE_MAX)', () => {
    for (let i = 0; i < 100; i++) {
      const port = randomPort();
      expect(port).toBeGreaterThanOrEqual(PORT_RANGE_MIN);
      expect(port).toBeLessThan(PORT_RANGE_MAX);
    }
  });

  it('returns integers', () => {
    for (let i = 0; i < 100; i++) {
      const port = randomPort();
      expect(Number.isInteger(port)).toBe(true);
    }
  });

  it('produces varying results across multiple calls', () => {
    const ports = new Set<number>();
    for (let i = 0; i < 100; i++) {
      ports.add(randomPort());
    }
    expect(ports.size).toBeGreaterThanOrEqual(2);
  });
});
