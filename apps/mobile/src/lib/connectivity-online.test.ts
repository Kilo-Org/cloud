import { describe, expect, it } from 'vitest';

import { connectivityStatus, isOnline } from '@/lib/connectivity-online';

describe('connectivityStatus', () => {
  it('is unknown when both fields are null (NetInfo boot)', () => {
    expect(connectivityStatus({ isConnected: null, isInternetReachable: null })).toBe('unknown');
  });

  it('is unknown when connected but reachability is null (NetInfo boot)', () => {
    expect(connectivityStatus({ isConnected: true, isInternetReachable: null })).toBe('unknown');
  });

  it('is online when reachability is true', () => {
    expect(connectivityStatus({ isConnected: true, isInternetReachable: true })).toBe('online');
    expect(connectivityStatus({ isConnected: false, isInternetReachable: true })).toBe('online');
    expect(connectivityStatus({ isConnected: null, isInternetReachable: true })).toBe('online');
  });

  it('is offline when reachability is false', () => {
    expect(connectivityStatus({ isConnected: true, isInternetReachable: false })).toBe('offline');
    expect(connectivityStatus({ isConnected: false, isInternetReachable: false })).toBe('offline');
  });

  it('is offline when disconnected and reachability is null', () => {
    expect(connectivityStatus({ isConnected: false, isInternetReachable: null })).toBe('offline');
  });
});

describe('isOnline', () => {
  it('is true only for a confirmed online state', () => {
    expect(isOnline({ isConnected: true, isInternetReachable: true })).toBe(true);
  });

  it('is false for offline', () => {
    expect(isOnline({ isConnected: true, isInternetReachable: false })).toBe(false);
    expect(isOnline({ isConnected: false, isInternetReachable: false })).toBe(false);
    expect(isOnline({ isConnected: false, isInternetReachable: null })).toBe(false);
  });

  it('does not treat unknown as online', () => {
    expect(isOnline({ isConnected: null, isInternetReachable: null })).toBe(false);
    expect(isOnline({ isConnected: true, isInternetReachable: null })).toBe(false);
  });
});
