// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveSessionComposerDisabled } from './session-composer-disabled';

const idleInput = {
  isReadOnly: false,
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

  it('stays unlocked for a writable session that cannot send (failed turn)', () => {
    // Pylon 28248: the send capability is a separate gate (`sendDisabled` on
    // ChatComposer). A session that cannot accept a message right now must
    // still leave the reader able to type beside the error's Retry, so this
    // resolver never reads the send capability. Assert on the resolver's
    // source: an input-shaped assertion here would be tautological, because
    // the test owns the input object it inspects.
    const resolverSource = readFileSync(
      fileURLToPath(new URL('session-composer-disabled.ts', import.meta.url)),
      'utf8'
    );
    expect(resolverSource).not.toMatch(/canSend/);
    expect(resolveSessionComposerDisabled(idleInput)).toBe(false);
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

  it('gates sending without locking the input', () => {
    const sourcePath = fileURLToPath(new URL('session-detail-content.tsx', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    expect(source).toMatch(/sendDisabled=\{!canSend\}/);
  });
});
