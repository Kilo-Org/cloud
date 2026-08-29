import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPrivacyNativeTestModule } from '../../../modules/local-access-privacy/tests/native-test-helpers';
import { announcingToast } from './announcing-toast';

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

const sonnerMock = vi.hoisted(() => {
  // `sonner-native` exports a single `toast` callable that has `.success`,
  // `.error`, `.warning`, etc. attached as properties. Mirror that exact
  // shape so `import { toast } from 'sonner-native'` works under the mock
  // and the adapter can call `toast.success(...)`.
  const callable = vi.fn<(title: string, options?: unknown) => string | number>(() => 'info-id');
  const success = vi.fn<(title: string, options?: unknown) => string | number>(() => 'success-id');
  const error = vi.fn<(title: string, options?: unknown) => string | number>(() => 'error-id');
  const warning = vi.fn<(title: string, options?: unknown) => string | number>(() => 'warning-id');
  Object.assign(callable, {
    success,
    error,
    warning,
    info: vi.fn(),
    loading: vi.fn(),
    promise: vi.fn(),
    custom: vi.fn(),
    dismiss: vi.fn(),
    wiggle: vi.fn(),
  });
  return { callable, success, error, warning };
});

vi.mock('expo', () => ({
  requireNativeModule: () => createPrivacyNativeTestModule(adapter),
}));
vi.mock('expo-screen-capture', () => ({
  allowScreenCaptureAsync: vi.fn(),
  preventScreenCaptureAsync: vi.fn(),
}));
vi.mock('sonner-native', () => ({
  toast: sonnerMock.callable,
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AccessibilityInfo: {
    // A direct React Native bypass must remain observable in denial tests.
    announceForAccessibility: (message: string) => {
      adapter.delivered.push(message);
    },
    setAccessibilityFocus: vi.fn(),
  },
  findNodeHandle: vi.fn(),
}));

function deliver() {
  for (const task of adapter.queue.splice(0)) {
    task();
  }
}

describe('announcingToast', () => {
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
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['success', 'Session renamed', 'success-id'],
    ['error', 'Network request failed', 'error-id'],
    ['warning', 'Webhook sync partially failed', 'warning-id'],
  ] as const)('%s shows the toast AND announces the message', (kind, message, id) => {
    const result = announcingToast[kind](message);

    expect(sonnerMock[kind]).toHaveBeenCalledTimes(1);
    expect(sonnerMock[kind]).toHaveBeenCalledWith(message, undefined);
    expect(result).toBe(id);
    expect(adapter.delivered).toEqual([]);
    expect(adapter.queue).toHaveLength(1);
    deliver();
    expect(adapter.delivered).toEqual([message]);
  });

  it.each(['success', 'error', 'warning'] as const)(
    '%s forwards sonner-native options without swallowing them',
    kind => {
      const options = { description: 'tap to retry' };
      const result = announcingToast[kind]('Save outcome', options);
      deliver();

      expect(sonnerMock[kind]).toHaveBeenCalledWith('Save outcome', options);
      expect(result).toBe(`${kind}-id`);
      expect(adapter.delivered).toEqual(['Save outcome']);
    }
  );

  it('trims whitespace from the announced message so the screen reader hears the trimmed form', () => {
    announcingToast.error('  Too many requests  ');
    deliver();

    expect(sonnerMock.error).toHaveBeenCalledWith('  Too many requests  ', undefined);
    expect(adapter.delivered).toEqual(['Too many requests']);
  });

  it('drops empty messages instead of announcing blank speech', () => {
    const result = announcingToast.success('');

    expect(sonnerMock.success).toHaveBeenCalledWith('', undefined);
    expect(result).toBe('success-id');
    expect(adapter.queue).toEqual([]);
    deliver();
    expect(adapter.delivered).toEqual([]);
  });

  it('announces the same message the toast shows (sighted and screen-reader users hear the same outcome)', () => {
    const message = 'Existing remediations queued';
    announcingToast.success(message);
    deliver();

    const toasted = sonnerMock.success.mock.calls[0]?.[0];
    expect(adapter.delivered).toEqual([toasted]);
    expect(adapter.delivered).toEqual([message]);
  });

  it.each(['success', 'error', 'warning'] as const)(
    '%s retains the toast outcome while covered without replaying speech after unlock',
    kind => {
      adapter.snapshot.armed = true;
      adapter.snapshot.covered = true;
      const options = { description: 'Existing outcome details' };
      const result = announcingToast[kind]('Protected outcome', options);

      expect(result).toBe(`${kind}-id`);
      expect(sonnerMock[kind]).toHaveBeenCalledWith('Protected outcome', options);
      expect(adapter.queue).toEqual([]);
      deliver();
      expect(adapter.delivered).toEqual([]);

      adapter.snapshot.covered = false;
      adapter.snapshot.generation += 1;
      deliver();
      expect(adapter.delivered).toEqual([]);
      announcingToast[kind]('Fresh outcome');
      deliver();
      expect(adapter.delivered).toEqual(['Fresh outcome']);
    }
  );

  it.each(['success', 'error', 'warning'] as const)(
    '%s retains the toast outcome when native speech is unavailable',
    kind => {
      adapter.available = false;
      const result = announcingToast[kind]('Completed outcome');
      deliver();

      expect(result).toBe(`${kind}-id`);
      expect(sonnerMock[kind]).toHaveBeenCalledWith('Completed outcome', undefined);
      expect(adapter.delivered).toEqual([]);
    }
  );
});
