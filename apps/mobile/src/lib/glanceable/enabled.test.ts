import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseGlanceableEnabled,
  readGlanceableEnabled,
  serializeGlanceableEnabled,
} from './enabled';

const { getItemAsync } = vi.hoisted(() => ({ getItemAsync: vi.fn() }));
vi.mock('expo-secure-store', () => ({ getItemAsync }));

describe('parseGlanceableEnabled', () => {
  it.each([
    [null, true],
    ['true', true],
    ['', true],
    ['nonsense', true],
    ['false', false],
  ])('reads %j as %s', (raw, expected) => {
    expect(parseGlanceableEnabled(raw)).toBe(expected);
  });

  it('round-trips both states', () => {
    expect(parseGlanceableEnabled(serializeGlanceableEnabled(false))).toBe(false);
    expect(parseGlanceableEnabled(serializeGlanceableEnabled(true))).toBe(true);
  });
});

describe('readGlanceableEnabled', () => {
  beforeEach(() => {
    getItemAsync.mockReset();
  });

  it('reads the stored switch', async () => {
    getItemAsync.mockResolvedValue('false');
    expect(await readGlanceableEnabled()).toBe(false);
    expect(getItemAsync).toHaveBeenCalledWith('glanceable-surfaces-enabled');
  });

  it('keeps the surfaces on when the read fails', async () => {
    getItemAsync.mockRejectedValue(new Error('storage unavailable'));
    expect(await readGlanceableEnabled()).toBe(true);
  });
});
