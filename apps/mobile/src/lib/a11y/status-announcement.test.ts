import { describe, expect, it, vi } from 'vitest';

import { createPrivacyNativeTestModule } from '../../../modules/local-access-privacy/tests/native-test-helpers';
import { nextAnnouncement } from './status-announcement';

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

vi.mock('expo', () => ({
  requireNativeModule: () => createPrivacyNativeTestModule(adapter),
}));
vi.mock('expo-screen-capture', () => ({
  allowScreenCaptureAsync: vi.fn(),
  preventScreenCaptureAsync: vi.fn(),
}));

const accessibilityMock = vi.hoisted(() => ({
  announceForAccessibility: vi.fn(),
  setAccessibilityFocus: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AccessibilityInfo: accessibilityMock,
  findNodeHandle: vi.fn(),
}));

describe('nextAnnouncement', () => {
  it('returns a new message so it is announced', () => {
    expect(nextAnnouncement(null, 'Failed to load')).toBe('Failed to load');
    expect(nextAnnouncement('Previous error', 'New error')).toBe('New error');
  });

  it('returns null for a repeated message so it is not re-announced', () => {
    expect(nextAnnouncement('Failed to load', 'Failed to load')).toBeNull();
    // Whitespace-only differences are not a real change.
    expect(nextAnnouncement('Failed to load', '  Failed to load  ')).toBeNull();
  });

  it('returns null when the status clears', () => {
    expect(nextAnnouncement('Failed to load', null)).toBeNull();
  });

  it('returns null for empty or whitespace-only messages', () => {
    expect(nextAnnouncement(null, '')).toBeNull();
    expect(nextAnnouncement('Failed to load', '')).toBeNull();
    expect(nextAnnouncement('Failed to load', '   ')).toBeNull();
    expect(nextAnnouncement('Failed to load', '\n\t')).toBeNull();
  });

  it('trims the announced message so the screen reader hears the trimmed form', () => {
    expect(nextAnnouncement(null, '  Agent needs your input  ')).toBe('Agent needs your input');
  });
});
