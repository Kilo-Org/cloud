/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as preferences-screen.mounted.test.tsx) */
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { VoiceInputSettingsScreen } from '@/components/voice-input-settings-screen';
import {
  findConfigureRow,
  findGatewaySwitch,
  findQueryErrors,
  findTexts,
} from '@/components/voice-input-settings-screen.test-helpers';
import { renderWithProviders } from '@/test/render-with-providers';

type SelectionStatus = 'off' | 'loading' | 'error' | 'empty' | 'unavailable' | 'ready';
type SelectionState = {
  status: SelectionStatus;
  model: { id: string; name: string } | null;
  models: { id: string; name: string }[];
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
};

function emptySelection(): SelectionState {
  return {
    status: 'off',
    model: null,
    models: [],
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn<() => void>(),
  };
}

const push = vi.hoisted(() => vi.fn());
const gatewayTranscription = vi.hoisted(() => ({
  enabled: false,
  hasLoaded: true,
  setEnabled: vi.fn(),
}));
const selection = vi.hoisted(() => ({ current: emptySelection() }));
const selectionArgs = vi.hoisted(() => ({ organizationId: undefined as string | undefined }));
const organization = vi.hoisted(() => ({ organizationId: 'org-1' as string | null }));
const voiceLanguage = vi.hoisted(() => ({ chosen: null as string | null, loaded: true }));

vi.mock('react-native', () => ({
  Switch: 'Switch',
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push }),
}));
vi.mock('@/components/ui/icons', () => ({
  Cpu: 'Cpu',
  Globe: 'Globe',
  Mic: 'Mic',
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/voice-test-field', () => ({ VoiceTestField: 'VoiceTestField' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ secondaryForeground: '#000000', mutedForeground: '#000000' }),
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: organization.organizationId }),
}));
// The real module resolves endonyms through `@/i18n/resolve-language`, which
// imports the native localization/recognition modules; stub the native edges
// so the row's display name runs for real without the device services.
vi.mock('expo-localization', () => ({
  getLocales: () => [{ languageTag: 'en-US' }],
}));
vi.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: { getSupportedLocales: vi.fn() },
}));
vi.mock('@/lib/voice-input/voice-input-language-preference', () => ({
  useVoiceInputLanguage: () => voiceLanguage.chosen,
  useVoiceInputLanguageLoaded: () => voiceLanguage.loaded,
}));
vi.mock('@/lib/voice-input/gateway/gateway-transcription-preference', () => ({
  useGatewayTranscriptionPreference: () => ({
    gatewayTranscriptionEnabled: gatewayTranscription.enabled,
    hasLoaded: gatewayTranscription.hasLoaded,
    setGatewayTranscriptionEnabled: gatewayTranscription.setEnabled,
  }),
}));
vi.mock('@/lib/voice-input/gateway/gateway-transcription-model-selection', () => ({
  useGatewayTranscriptionModelSelection: (organizationId?: string) => {
    selectionArgs.organizationId = organizationId;
    return selection.current;
  },
}));

const MODELS = [
  { id: 'kilo/whisper-large-v3', name: 'Whisper Large v3' },
  { id: 'openai/gpt-4o-mini-transcribe', name: 'GPT-4o Mini Transcribe' },
];

function setSelection(patch: Partial<SelectionState>): void {
  selection.current = { ...selection.current, ...patch };
}

let view: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;
async function mountVoiceInput(): Promise<ReactTestRenderer> {
  view = await renderWithProviders(<VoiceInputSettingsScreen />);
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  return view.renderer;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.resetAllMocks();
  gatewayTranscription.enabled = false;
  gatewayTranscription.hasLoaded = true;
  organization.organizationId = 'org-1';
  selectionArgs.organizationId = undefined;
  voiceLanguage.chosen = null;
  voiceLanguage.loaded = true;
  selection.current = emptySelection();
});
afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe('VoiceInputSettingsScreen', () => {
  it('renders the gateway transcription switch and its title and subtitle', async () => {
    const renderer = await mountVoiceInput();

    expect(findGatewaySwitch(renderer).props).toMatchObject({ value: false, disabled: false });

    const texts = findTexts(renderer);
    expect(texts).toContain('Gateway transcription');
    expect(texts).toContain(
      "Transcribe voice input with a Kilo gateway model instead of the device's speech recognition. Your recording is sent to the Kilo gateway."
    );
  });

  it('scopes the model catalogue read to the selected organization', async () => {
    organization.organizationId = 'org-42';
    await mountVoiceInput();

    expect(selectionArgs.organizationId).toBe('org-42');
  });

  it('reads the catalogue unscoped for a personal account', async () => {
    organization.organizationId = null;
    await mountVoiceInput();

    expect(selectionArgs.organizationId).toBeUndefined();
  });

  it('shows the empty caption disabled while the switch is off', async () => {
    // The catalogue is loaded, so the hook reports a model; the off status must
    // still win and keep the caption unset rather than naming that model.
    setSelection({ status: 'off', model: MODELS[0], models: MODELS });
    const renderer = await mountVoiceInput();

    expect(findConfigureRow(renderer, 'Transcription model').props).toMatchObject({
      icon: 'Cpu',
      subtitle: 'None chosen',
      disabled: true,
    });
    // The language row is now the group's final row, so the model row must not
    // carry the divider-suppressing `last`.
    expect(findConfigureRow(renderer, 'Transcription model').props.last).toBeUndefined();
    expect(findConfigureRow(renderer, 'Language').props.last).toBe(true);
  });

  it('shows the loading caption disabled while the catalogue settles', async () => {
    gatewayTranscription.enabled = true;
    setSelection({ status: 'loading', isLoading: true });
    const renderer = await mountVoiceInput();

    expect(findConfigureRow(renderer, 'Transcription model').props).toMatchObject({
      subtitle: 'Loading…',
      disabled: true,
    });
    expect(findQueryErrors(renderer)).toHaveLength(0);
  });

  it('shows the auto-selected model and opens the picker when ready', async () => {
    gatewayTranscription.enabled = true;
    setSelection({ status: 'ready', model: MODELS[0], models: MODELS });
    const renderer = await mountVoiceInput();

    const row = findConfigureRow(renderer, 'Transcription model');
    expect(row.props).toMatchObject({ subtitle: 'Whisper Large v3', disabled: false });

    act(() => {
      (row.props.onPress as () => void)();
    });
    expect(push).toHaveBeenCalledWith('/(app)/transcription-model-picker');
  });

  it('keeps an unavailable stored model, opens the picker, and shows the notice with no retry', async () => {
    gatewayTranscription.enabled = true;
    setSelection({ status: 'unavailable', model: MODELS[0], models: MODELS });
    const renderer = await mountVoiceInput();

    const row = findConfigureRow(renderer, 'Transcription model');
    expect(row.props).toMatchObject({ subtitle: 'Whisper Large v3', disabled: false });

    act(() => {
      (row.props.onPress as () => void)();
    });
    expect(push).toHaveBeenCalledWith('/(app)/transcription-model-picker');

    expect(findTexts(renderer)).toContain(
      'This model is no longer offered. Tap Transcription model to choose another.'
    );
    // The dictation error copy sends the reader to Preferences, where this
    // screen already is; only the row-pointing notice renders here.
    expect(findTexts(renderer)).not.toContain(
      "This transcription model isn't available. Pick another one in Preferences."
    );
    // A retry cannot restore a dropped model, so no error state/retry renders.
    expect(findQueryErrors(renderer)).toHaveLength(0);
    expect(findTexts(renderer)).not.toContain('Retry');
  });

  it('shows the error state with a working retry and keeps the switch enabled', async () => {
    gatewayTranscription.enabled = true;
    const refetch = vi.fn<() => void>();
    setSelection({ status: 'error', isLoading: false, isError: true, refetch });
    const renderer = await mountVoiceInput();

    // The row is disabled and carries no failure copy: the state block below is
    // the single message, so the same failure is never read twice.
    expect(findConfigureRow(renderer, 'Transcription model').props).toMatchObject({
      subtitle: '—',
      disabled: true,
    });
    expect(findGatewaySwitch(renderer).props.disabled).toBe(false);

    const [errorState] = findQueryErrors(renderer);
    if (!errorState) {
      throw new Error('QueryError not found');
    }
    expect(errorState.props).toMatchObject({
      variant: 'server',
      placement: 'top',
      title: "Couldn't load transcription models.",
    });
    act(() => {
      (errorState.props.onRetry as () => void)();
    });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state with a working retry and keeps the switch enabled', async () => {
    gatewayTranscription.enabled = true;
    const refetch = vi.fn<() => void>();
    setSelection({ status: 'empty', isLoading: false, isError: false, models: [], refetch });
    const renderer = await mountVoiceInput();

    // The row is disabled and carries no failure copy: the state block below is
    // the single message, so the same failure is never read twice.
    expect(findConfigureRow(renderer, 'Transcription model').props).toMatchObject({
      subtitle: '—',
      disabled: true,
    });
    expect(findGatewaySwitch(renderer).props.disabled).toBe(false);

    const [emptyState] = findQueryErrors(renderer);
    if (!emptyState) {
      throw new Error('QueryError not found');
    }
    expect(emptyState.props).toMatchObject({
      placement: 'top',
      title: 'No transcription models',
      message: 'The gateway offers no transcription models right now.',
    });
    act(() => {
      (emptyState.props.onRetry as () => void)();
    });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it.each(['ready', 'unavailable'] as const)(
    'never renders the empty caption while enabled with a non-empty list (%s)',
    async status => {
      gatewayTranscription.enabled = true;
      setSelection({ status, model: MODELS[0], models: MODELS });
      const renderer = await mountVoiceInput();

      expect(findTexts(renderer)).not.toContain('None chosen');
    }
  );

  it('keeps the gateway switch disabled until the preference has loaded', async () => {
    gatewayTranscription.hasLoaded = false;
    const renderer = await mountVoiceInput();

    expect(findGatewaySwitch(renderer).props.disabled).toBe(true);
  });

  it('shows the automatic language and opens the picker when no choice is stored', async () => {
    voiceLanguage.chosen = null;
    const renderer = await mountVoiceInput();

    const row = findConfigureRow(renderer, 'Language');
    expect(row.props).toMatchObject({
      icon: 'Globe',
      subtitle: 'Automatic',
      disabled: false,
    });

    act(() => {
      (row.props.onPress as () => void)();
    });
    expect(push).toHaveBeenCalledWith('/(app)/voice-language-picker');
  });

  it('names the stored voice language by its endonym', async () => {
    voiceLanguage.chosen = 'de-DE';
    const renderer = await mountVoiceInput();

    expect(findConfigureRow(renderer, 'Language').props).toMatchObject({
      subtitle: 'Deutsch',
      disabled: false,
    });
  });

  it('shows the loading caption and disables the language row until the choice has loaded', async () => {
    voiceLanguage.loaded = false;
    voiceLanguage.chosen = 'de-DE';
    const renderer = await mountVoiceInput();

    expect(findConfigureRow(renderer, 'Language').props).toMatchObject({
      subtitle: 'Loading…',
      disabled: true,
    });
  });

  it('renders the voice testing field below the model states', async () => {
    const renderer = await mountVoiceInput();

    const fields = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'VoiceTestField'
    );
    expect(fields).toHaveLength(1);
  });

  it('insets the scroll content so the focused test field clears the keyboard', async () => {
    const renderer = await mountVoiceInput();

    const [scroll] = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'ScrollView'
    );
    if (!scroll) {
      throw new Error('ScrollView not found');
    }
    expect(scroll.props.automaticallyAdjustKeyboardInsets).toBe(true);
  });
});
