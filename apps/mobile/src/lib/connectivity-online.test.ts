import { describe, expect, it } from 'vitest';

import { isOnline } from '@/lib/connectivity-online';

describe('isOnline', () => {
  it('lets isInternetReachable false win over isConnected true', () => {
    expect(isOnline({ isConnected: true, isInternetReachable: false })).toBe(false);
    expect(isOnline({ isConnected: false, isInternetReachable: false })).toBe(false);
  });

  it('prefers isInternetReachable true over isConnected false', () => {
    expect(isOnline({ isConnected: false, isInternetReachable: true })).toBe(true);
  });

  it('falls back to isConnected when isInternetReachable is null', () => {
    expect(isOnline({ isConnected: false, isInternetReachable: null })).toBe(false);
    expect(isOnline({ isConnected: true, isInternetReachable: null })).toBe(true);
  });

  it('defaults to online when both values are null', () => {
    expect(isOnline({ isConnected: null, isInternetReachable: null })).toBe(true);
  });
});
