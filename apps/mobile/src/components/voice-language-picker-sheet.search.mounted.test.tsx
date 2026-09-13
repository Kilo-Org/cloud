/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as transcription-model-picker-sheet.mounted.test.tsx) */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deviceState,
  mountSheet,
  preferenceState,
  resetVoiceLanguagePickerMocks,
  rowLabels,
  setQuery,
} from '@/components/voice-language-picker-sheet.test-helpers';

const DEVICE_LOCALES = ['de-DE', 'es-ES', 'nl-NL'];

describe('VoiceLanguagePickerSheet search', () => {
  beforeEach(resetVoiceLanguagePickerMocks);

  it('finds a device language by its English name', async () => {
    deviceState.current = {
      languages: DEVICE_LOCALES,
      isLoading: false,
      isError: false,
      refetch: vi.fn<() => void>(),
    };
    const renderer = await mountSheet();

    setQuery(renderer, 'german');

    expect(rowLabels(renderer)).toEqual(['Deutsch']);

    renderer.unmount();
  });

  it('finds a device language from a diacritic-free query', async () => {
    deviceState.current = {
      languages: DEVICE_LOCALES,
      isLoading: false,
      isError: false,
      refetch: vi.fn<() => void>(),
    };
    const renderer = await mountSheet();

    setQuery(renderer, 'espanol');

    expect(rowLabels(renderer)).toEqual(['Español']);

    renderer.unmount();
  });

  it('finds a gateway language from a diacritic-free query on its endonym', async () => {
    preferenceState.gatewayEnabled = true;
    const renderer = await mountSheet();

    setQuery(renderer, 'turkce');

    expect(rowLabels(renderer)).toContain('Türkçe');

    renderer.unmount();
  });

  it('finds a gateway language by its tag, like the canonical app language picker', async () => {
    preferenceState.gatewayEnabled = true;
    const renderer = await mountSheet();

    setQuery(renderer, 'zh-Hant');

    expect(rowLabels(renderer)).toEqual(['繁體中文']);

    renderer.unmount();
  });

  it('collates the gateway language list by endonym', async () => {
    preferenceState.gatewayEnabled = true;
    const renderer = await mountSheet();

    const labels = rowLabels(renderer).slice(1);
    expect(labels).toEqual(labels.toSorted((a, b) => a.localeCompare(b)));

    renderer.unmount();
  });
});
