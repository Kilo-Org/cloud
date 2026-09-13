/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as voice-language-picker-sheet.mounted.test.tsx) */
import { createElement, Fragment, type ReactNode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { VoiceLanguagePickerSheet } from '@/components/voice-language-picker-sheet';
import {
  __resetVoiceInputLanguageTagCacheForTests,
  resolveVoiceInputStartLanguageTag,
} from '@/lib/voice-input/voice-input-language';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const routerBack = vi.hoisted(() => vi.fn());

const preference = vi.hoisted(() => ({
  language: null as string | null,
  loaded: true,
  writeLanguage: vi.fn<(tag: string | null) => void>(),
}));

// The device-mode body runs the REAL `useVoiceRecognitionLanguages` hook, so the
// native `getSupportedLocales` boundary is the only thing faked here: this suite
// drives `getSupportedLocales` → `useVoiceRecognitionLanguages` → picker rows,
// which the hook-mocking `*.mounted.test.tsx` suites never exercise.
const getSupportedLocales = vi.hoisted(() => vi.fn());

// `SFSpeechRecognizer.supportedLocales()` reports identifiers, including the
// script-bearing Chinese tags the repo's own locale resolvers document as
// iOS-occurring (`zh-Hant-TW` in `resolve-language.ts`), a Latin-American
// Spanish identifier, and several same-language regions. The picker must render
// this OS-shaped list without collapsing, duplicating, or mislabelling it.
const IOS_SUPPORTED_LOCALES = [
  'ar-SA',
  'de-DE',
  'en-AU',
  'en-GB',
  'en-US',
  'es-419',
  'es-ES',
  'fr-FR',
  'ja-JP',
  'nb-NO',
  'pt-BR',
  'pt-PT',
  'sv-SE',
  'tr-TR',
  'zh-Hans-CN',
  'zh-Hant-TW',
];

vi.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: { getSupportedLocales },
}));
vi.mock('expo-localization', () => ({
  getLocales: () => [{ languageTag: 'en-US' }],
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: routerBack, push: vi.fn() }),
}));
vi.mock('@/lib/voice-input/gateway/gateway-transcription-preference', () => ({
  useGatewayTranscriptionPreference: () => ({
    gatewayTranscriptionEnabled: false,
    hasLoaded: true,
    setGatewayTranscriptionEnabled: vi.fn<(value: boolean) => void>(),
  }),
}));
vi.mock('@/lib/voice-input/voice-input-language-preference', () => ({
  useVoiceInputLanguage: () => preference.language,
  useVoiceInputLanguageLoaded: () => preference.loaded,
  writeVoiceInputLanguage: preference.writeLanguage,
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#888888' }),
}));

const flatListMock = vi.hoisted(
  () =>
    ({
      data,
      renderItem,
      keyExtractor,
      ListFooterComponent,
    }: {
      data: readonly unknown[];
      renderItem: (info: { item: unknown; index: number }) => ReactNode;
      keyExtractor: (item: unknown, index: number) => string;
      ListFooterComponent?: ReactNode;
    }) => {
      const rows = data.map((item, index) =>
        createElement(Fragment, { key: keyExtractor(item, index) }, renderItem({ item, index }))
      );
      return createElement('FlatList', null, ...rows, ListFooterComponent);
    }
);
vi.mock('react-native', () => ({
  FlatList: flatListMock,
  View: 'View',
  TextInput: 'TextInput',
  I18nManager: { isRTL: false },
}));

vi.mock('@/components/picker-sheet', () => ({
  PickerSheet: (props: { children?: ReactNode; headerContent?: ReactNode }) =>
    createElement('PickerSheet', props, props.headerContent, props.children),
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/choice-row', () => ({ ChoiceRow: 'ChoiceRow' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({ Mic: 'Mic', SearchX: 'SearchX' }));

// ── Helpers ────────────────────────────────────────────────────────────────

function findRows(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    // The mocked RN host components widen `node.type` to the DOM host union, so
    // compare through `string` the way the shared picker test helpers do.
    node => typeof node.type === 'string' && (node.type as string) === 'ChoiceRow'
  );
}

async function mountSheet(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(VoiceLanguagePickerSheet));
    // Resolve the mocked `getSupportedLocales` promise inside the act window so
    // the hook's loading state settles before the assertions run.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  routerBack.mockClear();
  preference.language = null;
  preference.loaded = true;
  preference.writeLanguage.mockClear();
  // The supported-locale list is memoized for the session, so every test starts
  // from an empty cache.
  __resetVoiceInputLanguageTagCacheForTests();
  getSupportedLocales.mockReset();
  getSupportedLocales.mockResolvedValue({
    locales: IOS_SUPPORTED_LOCALES,
    installedLocales: IOS_SUPPORTED_LOCALES,
  });
});

describe('VoiceLanguagePickerSheet iOS device locales', () => {
  it('renders the OS list without duplicating or dropping an entry', async () => {
    const renderer = await mountSheet();

    const rows = findRows(renderer);
    expect(rows).toHaveLength(IOS_SUPPORTED_LOCALES.length + 1);
    expect(rows[0]?.props).toMatchObject({ label: 'Automatic', description: 'Device language' });

    const tags = rows.slice(1).map(row => row.props.description as string);
    // Every locale the service reports is present exactly once, as the service
    // spelled it: no silent collapse and no repeated row.
    expect([...tags].toSorted()).toEqual([...IOS_SUPPORTED_LOCALES].toSorted());
    expect(new Set(tags).size).toBe(IOS_SUPPORTED_LOCALES.length);

    renderer.unmount();
  });

  it('names the iOS script and region identifiers by their endonym', async () => {
    const renderer = await mountSheet();

    const byTag = new Map(
      findRows(renderer).map(row => [row.props.description as string, row.props.label as string])
    );
    expect(byTag.get('de-DE')).toBe('Deutsch');
    expect(byTag.get('es-419')).toBe('Español');
    expect(byTag.get('pt-BR')).toBe('Português (Brasil)');
    expect(byTag.get('pt-PT')).toBe('Português (Portugal)');
    expect(byTag.get('zh-Hans-CN')).toBe('简体中文');
    expect(byTag.get('zh-Hant-TW')).toBe('繁體中文');
    expect(byTag.get('en-GB')).toBe('English');

    renderer.unmount();
  });

  it('checks the device-language default and writes the chosen iOS tag', async () => {
    const renderer = await mountSheet();

    // No stored choice yet: the Automatic row is the device-language default,
    // and no concrete locale is asserted as chosen.
    let rows = findRows(renderer);
    expect(rows[0]?.props.selected).toBe(true);
    expect(rows.slice(1).filter(row => row.props.selected === true)).toHaveLength(0);

    const traditionalChinese = rows.find(row => row.props.description === 'zh-Hant-TW');
    if (!traditionalChinese) {
      throw new Error('zh-Hant-TW row not found');
    }
    act(() => {
      (traditionalChinese.props.onPress as () => void)();
    });
    expect(preference.writeLanguage).toHaveBeenCalledWith('zh-Hant-TW');
    expect(routerBack).toHaveBeenCalledTimes(1);
    renderer.unmount();

    // Reopen with the choice persisted, as the settings screen does after a
    // SecureStore read: the same iOS tag's row is checked and Automatic is not.
    preference.language = 'zh-Hant-TW';
    const reopen = await mountSheet();
    rows = findRows(reopen);
    expect(rows.find(row => row.props.description === 'zh-Hant-TW')?.props.selected).toBe(true);
    expect(rows.find(row => row.props.description === 'zh-Hans-CN')?.props.selected).toBe(false);
    expect(rows[0]?.props.selected).toBe(false);

    reopen.unmount();
  });

  it('checks the stored iOS locale that resolves to the same language', async () => {
    // A tag persisted for another region of a language the list also reports
    // must check the row the recogniser can actually start.
    preference.language = 'pt-PT';
    const renderer = await mountSheet();

    const rows = findRows(renderer);
    const selected = rows.filter(row => row.props.selected === true);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.props).toMatchObject({
      description: 'pt-PT',
      label: 'Português (Portugal)',
    });

    renderer.unmount();
  });

  it('resolves the device-language default onto the OS list, not a hard-coded tag', async () => {
    // With no stored choice the picker leaves Automatic checked; the session
    // then starts in the device locale drawn from the same OS list. This is the
    // "current device locale is the default" behaviour, proven at the layer the
    // picker's Automatic row delegates to.
    expect(await resolveVoiceInputStartLanguageTag('en')).toBe('en-US');
  });
});
