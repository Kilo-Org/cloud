import { describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ OS: 'ios' as string }));

vi.mock('react-native', () => ({ Platform: platform }));

const { canOpenExternalBilling } = await import('./external-billing-link');

describe('canOpenExternalBilling', () => {
  it('refuses an external billing link on iOS', () => {
    platform.OS = 'ios';
    expect(canOpenExternalBilling()).toBe(false);
  });

  it('allows it on Android', () => {
    platform.OS = 'android';
    expect(canOpenExternalBilling()).toBe(true);
  });
});
