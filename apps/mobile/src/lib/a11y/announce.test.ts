import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Component, type RefObject } from 'react';

import { createPrivacyNativeTestModule } from '../../../modules/local-access-privacy/tests/native-test-helpers';
import { announceLocalAccessPrivacy } from '@/lib/local-access-privacy';
import { announceForA11y, moveA11yFocus } from './announce';

const adapter = vi.hoisted((): Parameters<typeof createPrivacyNativeTestModule>[0] => ({
  available: true,
  nativeFailure: false,
  secure: false,
  captureFailure: false,
  captureWait: undefined,
  captureEvents: [],
  snapshot: { generation: 0, armed: false, foreground: true, covered: false, failed: false },
  delivered: [],
  queue: [],
  listeners: new Map(),
}));
const nativeAnnounce = vi.hoisted(() =>
  vi.fn<ReturnType<typeof createPrivacyNativeTestModule>['announce']>()
);
const accessibilityMock = vi.hoisted(() => ({
  announceForAccessibility: vi.fn<(message: string) => void>(),
  setAccessibilityFocus: vi.fn<(node: number) => void>(),
  focusedNode: null as number | null,
}));
const findNodeHandleMock = vi.hoisted(() => vi.fn<(node: unknown) => number | null>(() => 42));

vi.mock('expo', () => ({
  requireNativeModule: () => ({
    ...createPrivacyNativeTestModule(adapter),
    announce: nativeAnnounce,
  }),
}));
vi.mock('expo-screen-capture', () => ({
  allowScreenCaptureAsync: vi.fn(),
  preventScreenCaptureAsync: vi.fn(),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AccessibilityInfo: accessibilityMock,
  findNodeHandle: findNodeHandleMock,
}));

function deliver() {
  for (const task of adapter.queue.splice(0)) {
    task();
  }
}

beforeEach(() => {
  adapter.available = true;
  adapter.snapshot = {
    generation: 0,
    armed: false,
    foreground: true,
    covered: false,
    failed: false,
  };
  adapter.delivered = [];
  adapter.queue = [];
  nativeAnnounce.mockReset().mockImplementation(createPrivacyNativeTestModule(adapter).announce);
  // Record unguarded delivery too, so a direct React Native bypass cannot pass.
  accessibilityMock.announceForAccessibility.mockReset().mockImplementation(message => {
    adapter.delivered.push(message);
  });
  accessibilityMock.focusedNode = null;
  accessibilityMock.setAccessibilityFocus.mockReset().mockImplementation(node => {
    accessibilityMock.focusedNode = node;
  });
  findNodeHandleMock.mockReset().mockReturnValue(42);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('announceForA11y', () => {
  it.each([false, true])('delivers allowed speech through the native queue (armed: %s)', armed => {
    adapter.snapshot.armed = armed;
    announceForA11y('Agent needs your input');

    expect(adapter.delivered).toEqual([]);
    expect(adapter.queue).toHaveLength(1);
    deliver();
    expect(adapter.delivered).toEqual(['Agent needs your input']);
    expect(adapter.snapshot.armed).toBe(armed);
  });

  it('trims surrounding whitespace before announcing', () => {
    announceForA11y('  Permission required  ');
    deliver();

    expect(adapter.delivered).toEqual(['Permission required']);
  });

  it('drops empty and whitespace-only messages', () => {
    announceForA11y('');
    announceForA11y('   ');
    announceForA11y('\n\t');

    expect(adapter.queue).toEqual([]);
    deliver();
    expect(adapter.delivered).toEqual([]);
  });

  it.each(['throw', 'rejection', 'missing module'] as const)(
    'preserves the caller flow after native %s without replaying failed speech',
    async failure => {
      if (failure === 'throw') {
        nativeAnnounce.mockImplementationOnce(() => {
          throw new Error('native announcement failed');
        });
      } else if (failure === 'rejection') {
        nativeAnnounce.mockRejectedValueOnce(new Error('native announcement failed'));
      } else {
        adapter.available = false;
      }

      expect(() => {
        announceForA11y('Session deleted');
      }).not.toThrow();
      await Promise.resolve();
      expect(adapter.delivered).toEqual([]);

      adapter.available = true;
      deliver();
      expect(adapter.delivered).toEqual([]);
      announceForA11y('New session created');
      deliver();
      expect(adapter.delivered).toEqual(['New session created']);
    }
  );

  it.each([
    { state: 'inactivity', foreground: false, failed: false },
    { state: 'cancelled authentication', foreground: true, failed: false },
    { state: 'native failure', foreground: true, failed: true },
  ])('suppresses protected speech during $state without replay after unlock', state => {
    adapter.snapshot = {
      generation: 1,
      armed: true,
      foreground: state.foreground,
      covered: true,
      failed: state.failed,
    };
    announceForA11y('Secret transcript');
    expect(adapter.queue).toEqual([]);
    deliver();
    expect(adapter.delivered).toEqual([]);

    adapter.snapshot = {
      ...adapter.snapshot,
      generation: 2,
      foreground: true,
      covered: false,
      failed: false,
    };
    deliver();
    expect(adapter.delivered).toEqual([]);
    announceForA11y('Fresh status');
    deliver();
    expect(adapter.delivered).toEqual(['Fresh status']);
  });

  it.each(['covered', 'unlocked'] as const)(
    'rejects native-queued speech across inactivity when delivery runs %s',
    deliveryState => {
      adapter.snapshot.armed = true;
      announceForA11y('Queued secret');
      expect(adapter.queue).toHaveLength(1);
      expect(adapter.delivered).toEqual([]);

      // Only native state changes: no JavaScript lifecycle event authorizes this delivery.
      adapter.snapshot = { ...adapter.snapshot, generation: 1, foreground: false, covered: true };
      if (deliveryState === 'unlocked') {
        adapter.snapshot = { ...adapter.snapshot, generation: 2, foreground: true, covered: false };
      }
      deliver();
      expect(adapter.delivered).toEqual([]);

      adapter.snapshot = { ...adapter.snapshot, generation: 2, foreground: true, covered: false };
      deliver();
      expect(adapter.delivered).toEqual([]);
      announceForA11y('Fresh status');
      deliver();
      expect(adapter.delivered).toEqual(['Fresh status']);
    }
  );

  it('keeps non-sensitive gate speech and focus separate from protected speech', async () => {
    adapter.snapshot.armed = true;
    adapter.snapshot.covered = true;
    findNodeHandleMock.mockReturnValueOnce(7);
    const gateRef: RefObject<Component | null> = {
      current: { node: 'gate' } as unknown as Component,
    };
    expect(moveA11yFocus(gateRef)).toBe(true);

    const gateSpeech = announceLocalAccessPrivacy('Unlock required', 'gate');
    announceForA11y('Secret transcript');
    deliver();

    expect(await gateSpeech).toBe(true);
    expect(adapter.delivered).toEqual(['Unlock required']);
    expect(accessibilityMock.focusedNode).toBe(7);
  });
});

describe('moveA11yFocus', () => {
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

  it('returns false and does not throw when the native focus move fails', () => {
    findNodeHandleMock.mockReturnValue(123);
    accessibilityMock.setAccessibilityFocus.mockImplementationOnce(() => {
      throw new Error('native focus move failed');
    });
    const ref: RefObject<Component | null> = {
      current: { node: 'placeholder' } as unknown as Component,
    };

    const moved = moveA11yFocus(ref);

    expect(moved).toBe(false);
    expect(accessibilityMock.setAccessibilityFocus).toHaveBeenCalledWith(123);
  });
});
