/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as transcription-model-picker-sheet.mounted.test.tsx) */
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deviceState,
  findByType,
  mountSheet,
  preferenceState,
  resetVoiceLanguagePickerMocks,
  routerBack,
  useVoiceRecognitionLanguagesMock,
} from '@/components/voice-language-picker-sheet.test-helpers';

describe('VoiceLanguagePickerSheet', () => {
  beforeEach(resetVoiceLanguagePickerMocks);

  it('lists the app languages in gateway mode and writes the pressed tag', async () => {
    preferenceState.gatewayEnabled = true;
    const renderer = await mountSheet();

    const rows = findByType(renderer.root, 'ChoiceRow');
    const german = rows.find(row => row.props.label === 'Deutsch');
    if (!german) {
      throw new Error('Deutsch row not found');
    }
    expect(german.props.description).toBe('German');
    // Gateway mode is static: it must not fetch the device's locale list.
    expect(useVoiceRecognitionLanguagesMock).not.toHaveBeenCalled();

    act(() => {
      (german.props.onPress as () => void)();
    });
    expect(preferenceState.writeLanguage).toHaveBeenCalledWith('de');
    expect(routerBack).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('lists the device locales first with Automatic in device mode', async () => {
    deviceState.current = {
      languages: ['de-DE', 'nl-NL'],
      isLoading: false,
      isError: false,
      refetch: vi.fn<() => void>(),
    };
    const renderer = await mountSheet();

    const rows = findByType(renderer.root, 'ChoiceRow');
    expect(rows[0]?.props.label).toBe('Automatic');
    expect(rows[1]?.props).toMatchObject({ label: 'Deutsch', description: 'de-DE' });
    expect(rows[2]?.props).toMatchObject({ label: 'Nederlands', description: 'nl-NL' });
    expect(useVoiceRecognitionLanguagesMock).toHaveBeenCalled();

    renderer.unmount();
  });

  it('marks the stored tag and writes it on press', async () => {
    preferenceState.language = 'nl-NL';
    deviceState.current = {
      languages: ['de-DE', 'nl-NL'],
      isLoading: false,
      isError: false,
      refetch: vi.fn<() => void>(),
    };
    const renderer = await mountSheet();

    const rows = findByType(renderer.root, 'ChoiceRow');
    expect(rows[0]?.props.selected).toBe(false);
    expect(rows[2]?.props.selected).toBe(true);

    const german = rows.find(row => row.props.label === 'Deutsch');
    if (!german) {
      throw new Error('Deutsch row not found');
    }
    act(() => {
      (german.props.onPress as () => void)();
    });
    expect(preferenceState.writeLanguage).toHaveBeenCalledWith('de-DE');
    expect(routerBack).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('checks the device locale that shares the stored gateway language', async () => {
    // A gateway choice (`zh-Hans`) is an app tag, but device mode offers OS
    // locales; the same-language match must be the one checked.
    preferenceState.language = 'zh-Hans';
    deviceState.current = {
      languages: ['zh-CN', 'de-DE'],
      isLoading: false,
      isError: false,
      refetch: vi.fn<() => void>(),
    };
    const renderer = await mountSheet();

    const rows = findByType(renderer.root, 'ChoiceRow');
    const selected = rows.filter(row => row.props.selected === true);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.props).toMatchObject({ description: 'zh-CN' });

    renderer.unmount();
  });

  it('checks the app language that shares the stored device locale in gateway mode', async () => {
    preferenceState.gatewayEnabled = true;
    preferenceState.language = 'de-DE';
    const renderer = await mountSheet();

    const rows = findByType(renderer.root, 'ChoiceRow');
    const selected = rows.filter(row => row.props.selected === true);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.props).toMatchObject({ label: 'Deutsch', description: 'German' });

    renderer.unmount();
  });

  it('checks the app Chinese script for the Android Mandarin tag in gateway mode', async () => {
    // p16: the device speech service stores the explicit choice as `cmn-Hans-CN`
    // (ISO 639-3 Mandarin). The gateway list offers the app languages, so the
    // picker must check the 简体中文 row — the same language the settings row
    // names — instead of falling back to Automatic with nothing checked.
    preferenceState.gatewayEnabled = true;
    preferenceState.language = 'cmn-Hans-CN';
    const renderer = await mountSheet();

    const rows = findByType(renderer.root, 'ChoiceRow');
    const selected = rows.filter(row => row.props.selected === true);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.props).toMatchObject({
      label: '简体中文',
      description: 'Chinese (Simplified)',
    });

    renderer.unmount();
  });

  it('checks Automatic when the stored tag has no option in the active mode', async () => {
    preferenceState.language = 'fil-PH';
    deviceState.current = {
      languages: ['de-DE'],
      isLoading: false,
      isError: false,
      refetch: vi.fn<() => void>(),
    };
    const renderer = await mountSheet();

    const rows = findByType(renderer.root, 'ChoiceRow');
    const selected = rows.filter(row => row.props.selected === true);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.props.label).toBe('Automatic');

    renderer.unmount();
  });

  it('shows the retryable error state and retries through refetch', async () => {
    const refetch = vi.fn<() => void>();
    deviceState.current = {
      languages: [],
      isLoading: false,
      isError: true,
      refetch,
    };
    const renderer = await mountSheet();

    const errorState = findByType(renderer.root, 'QueryError')[0];
    if (!errorState) {
      throw new Error('QueryError not found');
    }
    expect(errorState.props.title).toBe("Couldn't load the languages this device supports.");
    expect(findByType(renderer.root, 'ChoiceRow')).toHaveLength(0);

    act(() => {
      (errorState.props.onRetry as () => void)();
    });
    expect(refetch).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('shows the non-retryable empty state with no retry when the service reports zero locales', async () => {
    deviceState.current = {
      languages: [],
      isLoading: false,
      isError: false,
      refetch: vi.fn<() => void>(),
    };
    const renderer = await mountSheet();

    const emptyState = findByType(renderer.root, 'EmptyState')[0];
    expect(emptyState?.props).toMatchObject({
      title: 'No supported languages',
      description: "This device's speech recognition reports no supported languages.",
    });
    expect(findByType(renderer.root, 'QueryError')).toHaveLength(0);
    expect(findByType(renderer.root, 'FlatList')).toHaveLength(0);

    renderer.unmount();
  });

  it('holds skeleton rows while the device fetch is loading', async () => {
    deviceState.current = {
      languages: [],
      isLoading: true,
      isError: false,
      refetch: vi.fn<() => void>(),
    };
    const renderer = await mountSheet();

    expect(findByType(renderer.root, 'Skeleton')).toHaveLength(12);
    const skeletonRows = findByType(renderer.root, 'View').filter(
      node =>
        typeof node.props.className === 'string' &&
        node.props.className.includes('min-h-11') &&
        node.props.className.includes('py-3')
    );
    expect(skeletonRows).toHaveLength(6);
    expect(findByType(renderer.root, 'ChoiceRow')).toHaveLength(0);

    renderer.unmount();
  });

  it('holds skeleton rows until the preference store settles', async () => {
    preferenceState.languageLoaded = false;
    const renderer = await mountSheet();

    expect(findByType(renderer.root, 'Skeleton')).toHaveLength(12);
    expect(findByType(renderer.root, 'ChoiceRow')).toHaveLength(0);
    expect(useVoiceRecognitionLanguagesMock).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('keeps Automatic first in the row list', async () => {
    deviceState.current = {
      languages: ['en-US'],
      isLoading: false,
      isError: false,
      refetch: vi.fn<() => void>(),
    };
    const renderer = await mountSheet();

    const rows = findByType(renderer.root, 'ChoiceRow');
    expect(rows[0]?.props).toMatchObject({ label: 'Automatic', description: 'Device language' });

    renderer.unmount();
  });
});
