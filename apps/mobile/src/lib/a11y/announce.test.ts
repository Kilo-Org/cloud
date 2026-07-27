import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Component, type RefObject } from 'react';

import { announceForA11y, moveA11yFocus } from './announce';

const accessibilityMock = vi.hoisted(() => ({
  announceForAccessibility: vi.fn(),
  setAccessibilityFocus: vi.fn(),
}));

const findNodeHandleMock = vi.hoisted(() => vi.fn<(node: unknown) => number | null>(() => 42));

vi.mock('react-native', () => ({
  AccessibilityInfo: accessibilityMock,
  findNodeHandle: findNodeHandleMock,
}));

describe('announceForA11y', () => {
  beforeEach(() => {
    accessibilityMock.announceForAccessibility.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('forwards non-empty messages to AccessibilityInfo', () => {
    announceForA11y('Agent needs your input');

    expect(accessibilityMock.announceForAccessibility).toHaveBeenCalledTimes(1);
    expect(accessibilityMock.announceForAccessibility).toHaveBeenCalledWith(
      'Agent needs your input'
    );
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
    accessibilityMock.setAccessibilityFocus.mockClear();
    findNodeHandleMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns false when the ref has no mounted node', () => {
    findNodeHandleMock.mockReturnValueOnce(null);
    const ref: RefObject<Component | null> = { current: null };

    const moved = moveA11yFocus(ref);

    expect(moved).toBe(false);
    expect(findNodeHandleMock).toHaveBeenCalledWith(null);
    expect(accessibilityMock.setAccessibilityFocus).not.toHaveBeenCalled();
  });

  it('moves focus and returns true when a node handle is found', () => {
    findNodeHandleMock.mockReturnValueOnce(123);
    const ref: RefObject<Component | null> = {
      current: { node: 'placeholder' } as unknown as Component,
    };

    const moved = moveA11yFocus(ref);

    expect(moved).toBe(true);
    expect(findNodeHandleMock).toHaveBeenCalledWith(ref.current);
    expect(accessibilityMock.setAccessibilityFocus).toHaveBeenCalledWith(123);
  });
});
