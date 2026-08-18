// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveSessionComposerDisabled } from './session-composer-disabled';

const idleInput = {
  isReadOnly: false,
  canSend: true,
  shouldShowLoading: false,
  hasBlockingInteraction: false,
  requiresModel: false,
  hasModel: true,
};

describe('resolveSessionComposerDisabled', () => {
  it('returns false for a writable idle session', () => {
    expect(resolveSessionComposerDisabled(idleInput)).toBe(false);
  });

  it('returns true when read-only', () => {
    expect(resolveSessionComposerDisabled({ ...idleInput, isReadOnly: true })).toBe(true);
  });

  it('returns true when cannot send', () => {
    expect(resolveSessionComposerDisabled({ ...idleInput, canSend: false })).toBe(true);
  });

  it('returns true while loading', () => {
    expect(resolveSessionComposerDisabled({ ...idleInput, shouldShowLoading: true })).toBe(true);
  });

  it('returns true when a blocking interaction is active', () => {
    expect(resolveSessionComposerDisabled({ ...idleInput, hasBlockingInteraction: true })).toBe(
      true
    );
  });

  it('returns true when a model is required but missing', () => {
    expect(
      resolveSessionComposerDisabled({ ...idleInput, requiresModel: true, hasModel: false })
    ).toBe(true);
  });

  it('returns false when a model is required and present', () => {
    expect(
      resolveSessionComposerDisabled({ ...idleInput, requiresModel: true, hasModel: true })
    ).toBe(false);
  });
});

describe('composer unlock source check', () => {
  it('does not lock the composer on an error', () => {
    const sourcePath = fileURLToPath(new URL('session-detail-content.tsx', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    expect(source).not.toMatch(/Boolean\(error\)/);
  });
});
