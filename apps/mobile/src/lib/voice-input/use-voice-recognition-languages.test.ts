/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React trees under vitest (same pattern as src/lib/agent-attachments/use-agent-attachment-upload.test.ts) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetVoiceInputLanguageTagCacheForTests } from './voice-input-language';
import { useVoiceRecognitionLanguages } from './use-voice-recognition-languages';

// The hook delegates to `getVoiceRecognitionLocales`, which calls
// `ExpoSpeechRecognitionModule.getSupportedLocales`. Mocking the native module
// controls the fetch; mocking expo-localization keeps the import graph free of
// the native localization module this hook never uses.
const getSupportedLocalesMock = vi.hoisted(() =>
  vi.fn<() => Promise<{ locales: string[]; installedLocales: string[] }>>()
);

vi.mock('expo-localization', () => ({
  getLocales: () => [{ languageTag: 'en-US' }],
}));

vi.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: {
    getSupportedLocales: getSupportedLocalesMock,
  },
}));

type HookApi = ReturnType<typeof useVoiceRecognitionLanguages>;

const hookRef: { current: HookApi | undefined } = { current: undefined };

function Harness() {
  hookRef.current = useVoiceRecognitionLanguages();
  return null;
}

function hookApi(): HookApi {
  const current = hookRef.current;
  if (!current) {
    throw new Error('hook was not mounted');
  }
  return current;
}

async function mountHook(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(Harness));
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useVoiceRecognitionLanguages', () => {
  beforeEach(() => {
    __resetVoiceInputLanguageTagCacheForTests();
    getSupportedLocalesMock.mockReset();
  });

  it('maps the supported locales and settles the loading state', async () => {
    let resolveLocales:
      | ((value: { locales: string[]; installedLocales: string[] }) => void)
      | undefined = undefined;
    const pending = new Promise<{ locales: string[]; installedLocales: string[] }>(resolve => {
      resolveLocales = resolve;
    });
    getSupportedLocalesMock.mockReturnValue(pending);

    const renderer = await mountHook();
    // The service call is still in flight, so the picker keeps its skeletons.
    expect(hookApi().isLoading).toBe(true);

    await act(async () => {
      resolveLocales?.({ locales: ['de-DE', 'en-US'], installedLocales: ['en-US'] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hookApi().languages).toEqual(['de-DE', 'en-US']);
    expect(hookApi().isLoading).toBe(false);
    expect(hookApi().isError).toBe(false);

    renderer.unmount();
  });

  it('reports a null fetch result (service rejected) as the error state', async () => {
    getSupportedLocalesMock.mockRejectedValue(new Error('network failure'));

    const renderer = await mountHook();
    await settle();

    expect(hookApi().languages).toEqual([]);
    expect(hookApi().isError).toBe(true);
    expect(hookApi().isLoading).toBe(false);

    renderer.unmount();
  });

  it('reports a synchronous throw as the error state', async () => {
    getSupportedLocalesMock.mockImplementation(() => {
      throw new Error('package not found');
    });

    const renderer = await mountHook();
    await settle();

    expect(hookApi().isError).toBe(true);
    expect(hookApi().isLoading).toBe(false);

    renderer.unmount();
  });

  it('keeps an empty supported list as a successful, non-error answer', async () => {
    getSupportedLocalesMock.mockResolvedValue({ locales: [], installedLocales: [] });

    const renderer = await mountHook();
    await settle();

    expect(hookApi().languages).toEqual([]);
    expect(hookApi().isError).toBe(false);
    expect(hookApi().isLoading).toBe(false);

    renderer.unmount();
  });

  it('refetch invalidates the cache and re-queries the service', async () => {
    getSupportedLocalesMock.mockResolvedValue({ locales: ['de-DE'], installedLocales: [] });

    const renderer = await mountHook();
    await settle();
    expect(hookApi().languages).toEqual(['de-DE']);
    expect(getSupportedLocalesMock).toHaveBeenCalledTimes(1);

    // A plain re-query would replay the memoized first answer; refetch must
    // drop the cache so the new list is the one observed.
    getSupportedLocalesMock.mockResolvedValue({ locales: ['fr-FR'], installedLocales: [] });
    await act(async () => {
      hookApi().refetch();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hookApi().languages).toEqual(['fr-FR']);
    expect(getSupportedLocalesMock).toHaveBeenCalledTimes(2);

    renderer.unmount();
  });
});
