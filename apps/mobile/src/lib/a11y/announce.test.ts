import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RefObject } from 'react';
import { type HostInstance } from 'react-native';

import { announceForA11y, requestA11yFocus } from './announce';

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

  it('swallows a throwing native announcement so the caller flow continues', () => {
    accessibilityMock.announceForAccessibility.mockImplementationOnce(() => {
      throw new Error('native announcement failed');
    });

    expect(() => {
      announceForA11y('Session deleted');
    }).not.toThrow();
    expect(accessibilityMock.announceForAccessibility).toHaveBeenCalledWith('Session deleted');
  });
});

describe('requestA11yFocus', () => {
  beforeEach(() => {
    accessibilityMock.sendAccessibilityEvent.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns false when the ref has no mounted node', () => {
    const ref: RefObject<HostInstance | null> = { current: null };

    const requested = requestA11yFocus(ref);

    expect(requested).toBe(false);
    expect(accessibilityMock.sendAccessibilityEvent).not.toHaveBeenCalled();
  });

  it('reports dispatch without requiring native focus confirmation', () => {
    const node: Partial<HostInstance> = {};
    const ref: RefObject<HostInstance | null> = { current: node as HostInstance };

    const requested = requestA11yFocus(ref);

    expect(requested).toBe(true);
    expect(accessibilityMock.sendAccessibilityEvent).toHaveBeenCalledWith(node, 'focus');
  });

  it('returns false when the native request throws', () => {
    accessibilityMock.sendAccessibilityEvent.mockImplementationOnce(() => {
      throw new Error('native focus request failed');
    });
    const node: Partial<HostInstance> = {};
    const ref: RefObject<HostInstance | null> = { current: node as HostInstance };

    const requested = requestA11yFocus(ref);

    expect(requested).toBe(false);
    expect(accessibilityMock.sendAccessibilityEvent).toHaveBeenCalledWith(node, 'focus');
  });
});
