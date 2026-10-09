import { afterEach, expect, it, vi } from 'vitest';

import { remoteChatFetch } from './fetch';

const nativeFetch = vi.hoisted(() => vi.fn());
vi.mock('expo/fetch', () => ({ fetch: nativeFetch }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-crypto', () => ({ randomUUID: vi.fn() }));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn().mockResolvedValue(null),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

afterEach(() => vi.unstubAllGlobals());

it('refuses an approved local HTTP endpoint before sending release credentials', async () => {
  vi.stubGlobal('__DEV__', false);
  await expect(
    remoteChatFetch('http://192.168.1.8:8080/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer test-account-key' },
      body: '{"model":"local"}',
    })
  ).rejects.toMatchObject({ problem: 'httpReleaseUnavailable' });
  expect(nativeFetch).not.toHaveBeenCalled();
});
