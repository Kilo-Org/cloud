import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { announcingToast } from './announcing-toast';

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

const accessibilityMock = vi.hoisted(() => ({
  announceForAccessibility: vi.fn(),
}));

vi.mock('sonner-native', () => ({
  toast: sonnerMock.callable,
}));
vi.mock('react-native', () => ({
  AccessibilityInfo: accessibilityMock,
}));

describe('announcingToast', () => {
  beforeEach(() => {
    sonnerMock.success.mockClear();
    sonnerMock.error.mockClear();
    sonnerMock.warning.mockClear();
    accessibilityMock.announceForAccessibility.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('success shows the toast AND announces the message', () => {
    // oxlint-disable-next-line no-literal-copy/no-literal-copy
    const result = announcingToast.success('Session renamed');

    expect(sonnerMock.success).toHaveBeenCalledTimes(1);
    expect(sonnerMock.success).toHaveBeenCalledWith('Session renamed', undefined);
    expect(accessibilityMock.announceForAccessibility).toHaveBeenCalledTimes(1);
    expect(accessibilityMock.announceForAccessibility).toHaveBeenCalledWith('Session renamed');
    expect(result).toBe('success-id');
  });

  it('error shows the toast AND announces the message', () => {
    // oxlint-disable-next-line no-literal-copy/no-literal-copy
    const result = announcingToast.error('Network request failed');

    expect(sonnerMock.error).toHaveBeenCalledTimes(1);
    expect(sonnerMock.error).toHaveBeenCalledWith('Network request failed', undefined);
    expect(accessibilityMock.announceForAccessibility).toHaveBeenCalledTimes(1);
    expect(accessibilityMock.announceForAccessibility).toHaveBeenCalledWith(
      'Network request failed'
    );
    expect(result).toBe('error-id');
  });

  it('warning shows the toast AND announces the message', () => {
    // oxlint-disable-next-line no-literal-copy/no-literal-copy
    const result = announcingToast.warning('Webhook sync partially failed');

    expect(sonnerMock.warning).toHaveBeenCalledTimes(1);
    expect(sonnerMock.warning).toHaveBeenCalledWith('Webhook sync partially failed', undefined);
    expect(accessibilityMock.announceForAccessibility).toHaveBeenCalledTimes(1);
    expect(accessibilityMock.announceForAccessibility).toHaveBeenCalledWith(
      'Webhook sync partially failed'
    );
    expect(result).toBe('warning-id');
  });

  it('forwards sonner-native options without swallowing them', () => {
    const options = { description: 'tap to retry' };
    // oxlint-disable-next-line no-literal-copy/no-literal-copy
    announcingToast.error('Save failed', options);

    expect(sonnerMock.error).toHaveBeenCalledWith('Save failed', options);
  });
  it('trims whitespace from the announced message so the screen reader hears the trimmed form', () => {
    // oxlint-disable-next-line no-literal-copy/no-literal-copy
    announcingToast.error('  Too many requests  ');

    expect(accessibilityMock.announceForAccessibility).toHaveBeenCalledWith('Too many requests');
  });

  it('drops empty messages instead of announcing blank speech', () => {
    announcingToast.success('');

    expect(sonnerMock.success).toHaveBeenCalledWith('', undefined);
    expect(accessibilityMock.announceForAccessibility).not.toHaveBeenCalled();
  });

  it('announces the same message the toast shows (sighted and screen-reader users hear the same outcome)', () => {
    // Spot-check that announcement is derived from the actual toast title,
    // not a separate label that could drift out of sync.
    const message = 'Existing remediations queued';
    announcingToast.success(message);

    const announced = accessibilityMock.announceForAccessibility.mock.calls[0]?.[0];
    const toasted = sonnerMock.success.mock.calls[0]?.[0];
    expect(announced).toBe(toasted);
    expect(announced).toBe(message);
  });
});
