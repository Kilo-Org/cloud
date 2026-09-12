/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as transcription-model-picker-sheet.mounted.test.tsx) */
import { createElement, Fragment, type ReactNode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { VoiceLanguagePickerSheet } from '@/components/voice-language-picker-sheet';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const routerBack = vi.hoisted(() => vi.fn());

const preferenceState = vi.hoisted(() => ({
  gatewayEnabled: false,
  gatewayLoaded: true,
  language: null as string | null,
  languageLoaded: true,
  writeLanguage: vi.fn<(tag: string | null) => void>(),
}));

const deviceState = vi.hoisted(() => ({
  current: {
    languages: [] as string[],
    isLoading: false,
    isError: false,
    refetch: vi.fn<() => void>(),
  },
}));

const useVoiceRecognitionLanguagesMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/voice-input/gateway/gateway-transcription-preference', () => ({
  useGatewayTranscriptionPreference: () => ({
    gatewayTranscriptionEnabled: preferenceState.gatewayEnabled,
    hasLoaded: preferenceState.gatewayLoaded,
    setGatewayTranscriptionEnabled: vi.fn<(value: boolean) => void>(),
  }),
}));

vi.mock('@/lib/voice-input/voice-input-language-preference', () => ({
  useVoiceInputLanguage: () => preferenceState.language,
  useVoiceInputLanguageLoaded: () => preferenceState.languageLoaded,
  writeVoiceInputLanguage: preferenceState.writeLanguage,
}));

vi.mock('@/lib/voice-input/use-voice-recognition-languages', () => ({
  useVoiceRecognitionLanguages: useVoiceRecognitionLanguagesMock,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: routerBack, push: vi.fn() }),
}));
// The sheet reaches `voiceInputLanguageDisplayName`, which imports both native
// modules; mock them so the node environment never loads the native packages.
vi.mock('expo-localization', () => ({
  getLocales: () => [{ languageTag: 'en-US' }],
}));
vi.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: { getSupportedLocales: vi.fn() },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#888888' }),
}));

// FlatList renders through a callback, so a host-string mock would drop every
// row. This mock calls the render props so the row assertions still see rows.
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
  PickerSheet: (props: { children?: ReactNode }) =>
    createElement('PickerSheet', props, props.children),
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/choice-row', () => ({ ChoiceRow: 'ChoiceRow' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({ Mic: 'Mic', SearchX: 'SearchX' }));

// ── Helpers ────────────────────────────────────────────────────────────────

function findByType(root: TestRenderer.ReactTestInstance, type: string) {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

async function mountSheet(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(VoiceLanguagePickerSheet));
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('VoiceLanguagePickerSheet', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    routerBack.mockClear();
    preferenceState.writeLanguage.mockClear();
    preferenceState.gatewayEnabled = false;
    preferenceState.gatewayLoaded = true;
    preferenceState.language = null;
    preferenceState.languageLoaded = true;
    deviceState.current = {
      languages: [],
      isLoading: false,
      isError: false,
      refetch: vi.fn<() => void>(),
    };
    useVoiceRecognitionLanguagesMock.mockClear();
    useVoiceRecognitionLanguagesMock.mockImplementation(() => deviceState.current);
  });

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
