import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());
const shouldReject = vi.hoisted(() => ({ value: false }));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    if (shouldReject.value) {
      throw new Error('secure store unavailable');
    }
    return store.get(key) ?? null;
  }),
}));

describe('consent gate', () => {
  beforeEach(() => {
    store.clear();
    shouldReject.value = false;
  });

  it('returns needs-consent when consent has not been accepted', async () => {
    const { checkConsentGate } = await import('./consent-gate');

    expect(await checkConsentGate('user-1')).toEqual({ status: 'needs-consent' });
  });

  it('returns accepted when the current consent version is stored', async () => {
    const { CURRENT_CONSENT_VERSION } = await import('./consent');
    const { checkConsentGate } = await import('./consent-gate');
    store.set('consent-accepted-user-1', String(CURRENT_CONSENT_VERSION));

    expect(await checkConsentGate('user-1')).toEqual({ status: 'accepted' });
  });

  it('returns an error result when consent storage cannot be read', async () => {
    const { checkConsentGate } = await import('./consent-gate');
    shouldReject.value = true;

    const result = await checkConsentGate('user-1');

    expect(result.status).toBe('error');
  });
});
