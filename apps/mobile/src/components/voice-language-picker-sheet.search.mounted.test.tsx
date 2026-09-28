/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as transcription-model-picker-sheet.mounted.test.tsx) */
import { createElement } from 'react';
import { act, type TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deviceState,
  mountSheet,
  preferenceState,
  resetVoiceLanguagePickerMocks,
  rowLabels,
  setQuery,
} from '@/components/voice-language-picker-sheet.test-helpers';
import { VoiceLanguagePickerSheet } from '@/components/voice-language-picker-sheet';

const DEVICE_LOCALES = ['de-DE', 'es-ES', 'nl-NL'];

// The mocked FlatList renders through its render props and does not forward
// `data` to the host node, so the element carrying the render props is the one
// whose `data` identity the list was handed.
function listData(renderer: TestRenderer.ReactTestRenderer): unknown {
  const list = renderer.root.findAll(node => typeof node.props.renderItem === 'function')[0];
  if (!list) {
    throw new Error('FlatList not found');
  }
  return list.props.data;
}

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

  it('keeps the same list data identity when the gateway sheet re-renders without a query change', async () => {
    preferenceState.gatewayEnabled = true;
    const renderer = await mountSheet();
    const data = listData(renderer);

    await act(async () => {
      renderer.update(createElement(VoiceLanguagePickerSheet));
      await Promise.resolve();
    });

    // The gateway option array is built once per translation function, so an
    // unrelated re-render hands the list the same `data` identity and no mounted
    // row re-renders.
    expect(listData(renderer)).toBe(data);

    renderer.unmount();
  });
});
