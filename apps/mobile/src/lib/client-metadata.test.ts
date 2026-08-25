import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildClientMetadataHeaders } from '@/lib/client-metadata';

const applicationMock = vi.hoisted(() => ({
  nativeApplicationVersion: '1.0.4' as string | null,
}));
const platformMock = vi.hoisted(() => ({ OS: 'ios' as string }));

vi.mock('expo-application', () => applicationMock);
vi.mock('react-native', () => ({ Platform: platformMock }));

describe('buildClientMetadataHeaders', () => {
  beforeEach(() => {
    applicationMock.nativeApplicationVersion = '1.0.4';
    platformMock.OS = 'ios';
  });

  it('returns the mobile client, ios platform, and version headers', () => {
    expect(buildClientMetadataHeaders()).toEqual({
      'x-kilo-client': 'mobile',
      'x-kilo-app-platform': 'ios',
      'x-kilo-app-version': '1.0.4',
    });
  });

  it('returns android for a non-ios platform', () => {
    platformMock.OS = 'android';
    expect(buildClientMetadataHeaders()['x-kilo-app-platform']).toBe('android');
  });

  it('falls back to an empty version when nativeApplicationVersion is null', () => {
    applicationMock.nativeApplicationVersion = null;
    expect(buildClientMetadataHeaders()['x-kilo-app-version']).toBe('');
  });
});
