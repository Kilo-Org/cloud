import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RefObject } from 'react';
import { type HostInstance } from 'react-native';

import { announceForA11y, moveA11yFocus } from './announce';

const accessibilityMock = vi.hoisted(() => ({
  announceForAccessibility: vi.fn(),
  sendAccessibilityEvent: vi.fn(),
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: accessibilityMock,
}));

describe('announceForA11y', () => {
  beforeEach(() => {
    accessibilityMock.announceForAccessibility.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('trims surrounding whitespace before announcing', () => {
    announceForA11y('  Permission required  ');

    expect(accessibilityMock.announceForAccessibility).toHaveBeenCalledWith('Permission required');
  });

  it('drops empty and whitespace-only messages', () => {
    announceForA11y('');
    announceForA11y('   ');
    announceForA11y('\n\t');

    expect(accessibilityMock.announceForAccessibility).not.toHaveBeenCalled();
  });
});

describe('moveA11yFocus', () => {
  beforeEach(() => {
    accessibilityMock.sendAccessibilityEvent.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns false when the ref has no mounted node', () => {
    const ref: RefObject<HostInstance | null> = { current: null };

    const moved = moveA11yFocus(ref);

    expect(moved).toBe(false);
  });

  it('returns false and does not throw when the native focus move fails', () => {
    accessibilityMock.sendAccessibilityEvent.mockImplementationOnce(() => {
      throw new Error('native focus move failed');
    });
    const node: Partial<HostInstance> = {};
    const ref: RefObject<HostInstance | null> = { current: node as HostInstance };

    const moved = moveA11yFocus(ref);

    expect(moved).toBe(false);
  });
});
