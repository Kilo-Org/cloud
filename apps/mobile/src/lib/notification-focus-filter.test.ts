// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isAgentProgressAllowedInActiveFocus } from './notification-focus-filter';

const mocks = vi.hoisted(() => ({
  requireOptionalNativeModule: vi.fn(),
}));

vi.mock('expo', () => ({ requireOptionalNativeModule: mocks.requireOptionalNativeModule }));

const moduleSource = readFileSync(
  fileURLToPath(new URL('notification-focus-filter.ts', import.meta.url)),
  'utf8'
);

// Removes `//` line comments and `/* */` block comments while preserving line
// breaks, so the comment that names the iOS-only capability cannot satisfy the
// platform-contract assertion below.
function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, match => match.replaceAll(/[^\n]/g, ''))
    .replaceAll(/\/\/[^\n]*/g, '');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isAgentProgressAllowedInActiveFocus', () => {
  it('allows agent progress when the active iOS Focus stored the allowed choice', () => {
    mocks.requireOptionalNativeModule.mockReturnValue({ isAgentProgressAllowed: () => true });

    expect(isAgentProgressAllowedInActiveFocus()).toBe(true);
    expect(mocks.requireOptionalNativeModule).toHaveBeenCalledExactlyOnceWith(
      'NotificationFocusFilter'
    );
  });

  it('excludes agent progress when the active iOS Focus stored the excluded choice', () => {
    mocks.requireOptionalNativeModule.mockReturnValue({ isAgentProgressAllowed: () => false });

    expect(isAgentProgressAllowedInActiveFocus()).toBe(false);
  });

  it('allows agent progress when the module is absent, as on Android', () => {
    mocks.requireOptionalNativeModule.mockReturnValue(null);

    expect(isAgentProgressAllowedInActiveFocus()).toBe(true);
  });

  it('allows agent progress when the native read throws', () => {
    mocks.requireOptionalNativeModule.mockReturnValue({
      isAgentProgressAllowed: () => {
        throw new Error('shared container unavailable');
      },
    });

    expect(isAgentProgressAllowedInActiveFocus()).toBe(true);
  });
});

// Text contract: the Focus choice is read the same way on both platforms. Only
// iOS registers the module, so Android takes the absent-module fallback instead
// of a platform branch that would skip the read.
describe('notification focus filter platform contract', () => {
  it('never forks the Focus read on the platform', () => {
    expect(stripComments(moduleSource)).not.toMatch(/\bPlatform\b/);
  });
});
