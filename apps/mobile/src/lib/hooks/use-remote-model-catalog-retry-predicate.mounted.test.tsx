import { describe, expect, it, vi } from 'vitest';

import { shouldRetryRemoteModelCatalog } from '@/lib/hooks/use-remote-model-catalog-retry';

// The hook module imports AppState and the expo-router focus effect at the top
// level. This suite only reads its pure predicate, so stub both so the import
// resolves without mounting.
vi.mock('react-native', () => ({
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));
vi.mock('expo-router', () => ({ useFocusEffect: vi.fn() }));

describe('shouldRetryRemoteModelCatalog', () => {
  const base = {
    activeSessionType: 'remote' as const,
    ownerConnectionId: 'owner-1',
    protocol: 'v1' as const,
    refresh: 'idle' as const,
    modelCount: 0,
  };

  it('retries an empty catalog for a remote session with a known owner', () => {
    expect(shouldRetryRemoteModelCatalog(base)).toBe(true);
  });

  it('retries after an error even when a stale catalog is present', () => {
    expect(shouldRetryRemoteModelCatalog({ ...base, refresh: 'error', modelCount: 1 })).toBe(true);
  });

  it('never retries while the request is loading', () => {
    expect(shouldRetryRemoteModelCatalog({ ...base, refresh: 'loading' })).toBe(false);
  });

  it('never retries before the owner is known', () => {
    expect(shouldRetryRemoteModelCatalog({ ...base, ownerConnectionId: null })).toBe(false);
  });

  it('never retries a non-remote session', () => {
    expect(shouldRetryRemoteModelCatalog({ ...base, activeSessionType: 'cloud-agent' })).toBe(
      false
    );
  });

  it('does not retry a populated idle catalog', () => {
    expect(shouldRetryRemoteModelCatalog({ ...base, modelCount: 1 })).toBe(false);
  });

  it('never retries a legacy CLI: it cannot answer list_models', () => {
    expect(shouldRetryRemoteModelCatalog({ ...base, protocol: 'legacy' })).toBe(false);
    expect(shouldRetryRemoteModelCatalog({ ...base, protocol: 'legacy', refresh: 'error' })).toBe(
      false
    );
  });

  it('retries an unknown protocol only after an error', () => {
    expect(shouldRetryRemoteModelCatalog({ ...base, protocol: 'unknown' })).toBe(false);
    expect(shouldRetryRemoteModelCatalog({ ...base, protocol: 'unknown', refresh: 'error' })).toBe(
      true
    );
  });
});
