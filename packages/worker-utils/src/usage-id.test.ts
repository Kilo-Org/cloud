import { validate, version } from 'uuid';
import { describe, expect, it } from 'vitest';
import { createUsageId } from './usage-id';

describe('createUsageId', () => {
  it('mints distinct UUIDv7 ids', () => {
    const ids = Array.from({ length: 1000 }, () => createUsageId());

    for (const id of ids) {
      expect(validate(id)).toBe(true);
      expect(version(id)).toBe(7);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('embeds the minting time', () => {
    const before = Date.now();
    const id = createUsageId();
    const after = Date.now();

    const timestamp = parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });
});
