/* eslint-disable typescript-eslint/no-deprecated, max-lines -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest; this one harness mocks every native module the sheet reaches. */
import { createElement, Fragment, type ReactNode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { vi } from 'vitest';

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

export { deviceState, preferenceState, routerBack, useVoiceRecognitionLanguagesMock };

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
  PickerSheet: (props: { children?: ReactNode; headerContent?: ReactNode }) =>
    createElement('PickerSheet', props, props.headerContent, props.children),
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/choice-row', () => ({ ChoiceRow: 'ChoiceRow' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({ Mic: 'Mic', SearchX: 'SearchX' }));

// ── Helpers ────────────────────────────────────────────────────────────────

export function findByType(root: TestRenderer.ReactTestInstance, type: string) {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

export async function mountSheet(): Promise<TestRenderer.ReactTestRenderer> {
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

export function setQuery(renderer: TestRenderer.ReactTestRenderer, text: string): void {
  const input = findByType(renderer.root, 'TextInput')[0];
  if (!input) {
    throw new Error('search input not found');
  }
  act(() => {
    (input.props.onChangeText as (value: string) => void)(text);
  });
}

export function rowLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
  return findByType(renderer.root, 'ChoiceRow').map(row => row.props.label as string);
}

export function resetVoiceLanguagePickerMocks(): void {
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
}
