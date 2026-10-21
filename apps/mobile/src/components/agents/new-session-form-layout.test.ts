import { describe, expect, it } from 'vitest';

import {
  NEW_SESSION_SPLIT_MIN_WIDTH,
  resolveNewSessionFormLayout,
} from './new-session-form-layout';

describe('resolveNewSessionFormLayout', () => {
  it('keeps the stacked column on a portrait phone', () => {
    expect(resolveNewSessionFormLayout(411, 914)).toBe('stacked');
  });

  it('splits the same phone once it rotates', () => {
    expect(resolveNewSessionFormLayout(914, 411)).toBe('split');
  });

  it('keeps the stacked column on a landscape tablet, which has the height', () => {
    // `isShortViewport` reads the 600dp short edge as a tablet, not a phone on
    // its side: the stacked column fits there, so no split is owed.
    expect(resolveNewSessionFormLayout(1024, 768)).toBe('stacked');
    expect(resolveNewSessionFormLayout(1024, 600)).toBe('stacked');
  });

  it('keeps the stacked column on a short window too narrow for two columns', () => {
    expect(resolveNewSessionFormLayout(NEW_SESSION_SPLIT_MIN_WIDTH - 1, 360)).toBe('stacked');
    expect(resolveNewSessionFormLayout(NEW_SESSION_SPLIT_MIN_WIDTH, 360)).toBe('split');
  });

  it('keeps the stacked column on a square or unavailable window', () => {
    expect(resolveNewSessionFormLayout(500, 500)).toBe('stacked');
    expect(resolveNewSessionFormLayout(Number.NaN, 411)).toBe('stacked');
    expect(resolveNewSessionFormLayout(914, Number.NaN)).toBe('stacked');
  });
});
