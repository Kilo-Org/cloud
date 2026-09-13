/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as voice-language-picker-sheet.mounted.test.tsx) */
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deviceState,
  findByType,
  mountSheet,
  preferenceState,
  resetVoiceLanguagePickerMocks,
  routerBack,
} from '@/components/voice-language-picker-sheet.test-helpers';

/**
 * Device-mode proof for the iOS speech recognizer. PR 6099 was proved on
 * Android only; the device-mode list and its shape come from the OS speech
 * API, so this suite feeds the picker a representative
 * `SFSpeechRecognizer.supportedLocales()` answer (region variants for the same
 * language, script-bearing Chinese tags, and locales the app does not ship)
 * and asserts the device-mode path the owner will repeat on the simulator:
 * the iOS list renders in full and once each, the device locale is the default
 * through the Automatic row, the persisted choice comes back checked on
 * reopen, and pressing a row writes the OS spelling.
 */
const IOS_LOCALES = [
  'ar-SA',
  'de-AT',
  'de-CH',
  'de-DE',
  'en-AU',
  'en-CA',
  'en-GB',
  'en-IE',
  'en-IN',
  'en-NZ',
  'en-US',
  'en-ZA',
  'es-ES',
  'es-MX',
  'es-US',
  'fil-PH',
  'fr-BE',
  'fr-CA',
  'fr-CH',
  'fr-FR',
  'ja-JP',
  'yue-CN',
  'zh-CN',
  'zh-HK',
  'zh-TW',
];

function deviceLocales(languages: string[]): void {
  deviceState.current = {
    languages,
    isLoading: false,
    isError: false,
    refetch: vi.fn<() => void>(),
  };
}

describe('VoiceLanguagePickerSheet device mode on iOS', () => {
  beforeEach(resetVoiceLanguagePickerMocks);

  it('lists the iOS-supported languages, once each, with Automatic first', async () => {
    deviceLocales(IOS_LOCALES);
    const renderer = await mountSheet();

    const rows = findByType(renderer.root, 'ChoiceRow');
    expect(rows[0]?.props).toMatchObject({ label: 'Automatic', description: 'Device language' });

    // The rows are exactly the list the OS answered with — not the app's
    // static languages and not an Android list — and every tag is unique, so
    // no row is a duplicate entry.
    const descriptions = rows.slice(1).map(row => row.props.description as string);
    expect(descriptions).toEqual(IOS_LOCALES);
    expect(new Set(descriptions).size).toBe(descriptions.length);

    // A locale the app ships resolves to its endonym; one it does not keeps
    // the raw tag as the label rather than dropping or crashing on the row.
    const british = rows.find(row => row.props.description === 'en-GB');
    expect(british?.props.label).toBe('English');
    const cantonese = rows.find(row => row.props.description === 'yue-CN');
    expect(cantonese?.props.label).toBe('yue-CN');

    renderer.unmount();
  });

  it('selects Automatic — the current device locale — when nothing is stored', async () => {
    preferenceState.language = null;
    deviceLocales(IOS_LOCALES);
    const renderer = await mountSheet();

    const selected = findByType(renderer.root, 'ChoiceRow').filter(
      row => row.props.selected === true
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]?.props.label).toBe('Automatic');

    renderer.unmount();
  });

  it('checks the persisted choice after leaving and reopening the screen', async () => {
    preferenceState.language = 'en-GB';
    deviceLocales(IOS_LOCALES);
    const renderer = await mountSheet();

    const selected = findByType(renderer.root, 'ChoiceRow').filter(
      row => row.props.selected === true
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]?.props.description).toBe('en-GB');

    renderer.unmount();
  });

  it('writes the pressed OS tag and dismisses the sheet', async () => {
    deviceLocales(IOS_LOCALES);
    const renderer = await mountSheet();

    const rows = findByType(renderer.root, 'ChoiceRow');
    const british = rows.find(row => row.props.description === 'en-GB');
    if (!british) {
      throw new Error('en-GB row not found');
    }
    act(() => {
      (british.props.onPress as () => void)();
    });
    expect(preferenceState.writeLanguage).toHaveBeenCalledWith('en-GB');
    expect(routerBack).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });
});
