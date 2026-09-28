import { act, type ReactTestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import {
  findConfigureRow,
  findPreferenceRow,
  findQueryErrors,
  findTexts,
} from '@/components/tool-summary-translation-settings-screen.mounted.test-helpers';
import { ToolSummaryTranslationSettingsScreen } from '@/components/tool-summary-translation-settings-screen';
import { type ModelOption } from '@/lib/hooks/use-available-models';
import { renderWithProviders } from '@/test/render-with-providers';

type PickerParams = {
  options: { id: string; name: string }[];
  value: string;
  variant: string;
  onSelect: (id: string) => void;
};

const router = vi.hoisted(() => ({ push: vi.fn() }));
const openModelPicker = vi.hoisted(() => vi.fn<(router: unknown, params: PickerParams) => void>());
const organization = vi.hoisted(() => ({ organizationId: 'org-1' as string | null }));
const preference = vi.hoisted(() => ({
  enabled: false,
  model: { id: 'kilo-auto/small', name: 'Auto Small' },
  hasLoaded: true,
  setEnabled: vi.fn<(next: boolean) => void>(),
  setModel: vi.fn<(next: { id: string; name: string }) => void>(),
}));
const modelsState = vi.hoisted(() => ({
  models: [] as ModelOption[],
  isLoading: false,
  isError: false,
  isFetching: false,
  isFetched: true,
  refetch: vi.fn<() => void>(),
}));
const modelsArgs = vi.hoisted(() => ({ organizationId: undefined as string | undefined }));

vi.mock('react-native', () => ({
  Switch: 'Switch',
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('expo-router', () => ({
  useRouter: () => router,
}));
vi.mock('@/components/ui/icons', () => ({
  Cpu: 'Cpu',
  WandSparkles: 'WandSparkles',
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
vi.mock('@/components/ui/preference-row', () => ({ PreferenceRow: 'PreferenceRow' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ secondaryForeground: '#000000', mutedForeground: '#000000' }),
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: organization.organizationId }),
}));
vi.mock('@/components/agents/model-selector', () => ({ openModelPicker }));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: (organizationId?: string) => {
    modelsArgs.organizationId = organizationId;
    return modelsState;
  },
}));
vi.mock('@/lib/tool-summary-translation/tool-summary-translation-preference', () => ({
  useToolSummaryTranslationPreference: () => ({
    enabled: preference.enabled,
    model: preference.model,
    hasLoaded: preference.hasLoaded,
    setEnabled: preference.setEnabled,
    setModel: preference.setModel,
  }),
}));

const MODELS: ModelOption[] = [
  { id: 'kilo-auto/small', name: 'Auto Small', variants: [], isPreferred: true },
  {
    id: 'kilo-auto/frontier',
    name: 'Auto Frontier',
    variants: ['instant', 'thinking'],
    isPreferred: true,
  },
];

/**
 * The picker rows the screen hands the shared model picker: the catalogue's
 * gateway reasoning-effort variants are stripped, because the translation
 * model carries no effort and the shared picker only commits on tap for a
 * single-variant row.
 */
function withoutVariants(candidate: ModelOption): ModelOption {
  return { ...candidate, variants: [] };
}

let view: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;
async function mountScreen(): Promise<ReactTestRenderer> {
  view = await renderWithProviders(<ToolSummaryTranslationSettingsScreen />);
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  return view.renderer;
}
function lastPickerCall(): [unknown, PickerParams] {
  const call = openModelPicker.mock.calls.at(-1);
  if (!call) {
    throw new Error('openModelPicker was not called');
  }
  return call;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.resetAllMocks();
  organization.organizationId = 'org-1';
  preference.enabled = false;
  preference.model = { id: 'kilo-auto/small', name: 'Auto Small' };
  preference.hasLoaded = true;
  modelsState.models = MODELS;
  modelsState.isLoading = false;
  modelsState.isError = false;
  modelsState.isFetching = false;
  modelsState.isFetched = true;
  modelsState.refetch = vi.fn<() => void>();
  modelsArgs.organizationId = undefined;
});
afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe('ToolSummaryTranslationSettingsScreen', () => {
  it('renders the switch off with the model row disabled and the default Auto Small', async () => {
    const renderer = await mountScreen();

    expect(findPreferenceRow(renderer).props).toMatchObject({
      icon: 'WandSparkles',
      title: 'Translate tool summaries',
      subtitle:
        'Send each tool summary to a model to translate it into your app language. The original is shown if translation fails.',
      value: false,
      disabled: false,
    });
    expect(findConfigureRow(renderer, 'Model').props).toMatchObject({
      icon: 'Cpu',
      subtitle: 'Auto Small',
      disabled: true,
      last: true,
    });
  });

  it('toggles the switch and enables the model row once the preference is on', async () => {
    const renderer = await mountScreen();

    expect(findConfigureRow(renderer, 'Model').props.disabled).toBe(true);
    act(() => {
      (findPreferenceRow(renderer).props.onValueChange as (next: boolean) => void)(true);
    });
    expect(preference.setEnabled).toHaveBeenCalledWith(true);

    preference.enabled = true;
    const enabledRenderer = await mountScreen();
    expect(findConfigureRow(enabledRenderer, 'Model').props).toMatchObject({
      subtitle: 'Auto Small',
      disabled: false,
    });
  });

  it('scopes the model catalogue read to the selected organization', async () => {
    organization.organizationId = 'org-42';
    await mountScreen();

    expect(modelsArgs.organizationId).toBe('org-42');
  });

  it('reads the catalogue unscoped for a personal account', async () => {
    organization.organizationId = null;
    await mountScreen();

    expect(modelsArgs.organizationId).toBeUndefined();
  });

  it('shows the loading caption disabled while the catalogue settles', async () => {
    preference.enabled = true;
    modelsState.models = [];
    modelsState.isLoading = true;
    // First load: nothing has settled, so the query is not `isFetched` yet.
    modelsState.isFetched = false;
    const renderer = await mountScreen();

    expect(findConfigureRow(renderer, 'Model').props).toMatchObject({
      subtitle: 'Loading…',
      disabled: true,
    });
    expect(findQueryErrors(renderer)).toHaveLength(0);
  });

  it('shows the error state with a working retry and keeps the switch enabled', async () => {
    preference.enabled = true;
    const refetch = vi.fn<() => void>();
    modelsState.models = [];
    modelsState.isError = true;
    modelsState.refetch = refetch;
    const renderer = await mountScreen();

    // The row is disabled and carries no failure copy: the state block below is
    // the single message, so the same failure is never read twice.
    expect(findConfigureRow(renderer, 'Model').props).toMatchObject({
      subtitle: '—',
      disabled: true,
    });
    expect(findPreferenceRow(renderer).props.disabled).toBe(false);

    const [errorState] = findQueryErrors(renderer);
    if (!errorState) {
      throw new Error('QueryError not found');
    }
    expect(errorState.props).toMatchObject({
      variant: 'server',
      placement: 'top',
      title: 'Could not load models',
      isRetrying: false,
    });
    act(() => {
      (errorState.props.onRetry as () => void)();
    });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state with a working retry and keeps the switch enabled', async () => {
    preference.enabled = true;
    const refetch = vi.fn<() => void>();
    modelsState.models = [];
    modelsState.refetch = refetch;
    const renderer = await mountScreen();

    // The row is disabled and carries no failure copy: the state block below is
    // the single message, so the same failure is never read twice.
    expect(findConfigureRow(renderer, 'Model').props).toMatchObject({
      subtitle: '—',
      disabled: true,
    });
    expect(findPreferenceRow(renderer).props.disabled).toBe(false);

    const [emptyState] = findQueryErrors(renderer);
    if (!emptyState) {
      throw new Error('QueryError not found');
    }
    expect(emptyState.props).toMatchObject({
      placement: 'top',
      title: 'No models available',
      isRetrying: false,
    });
    act(() => {
      (emptyState.props.onRetry as () => void)();
    });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('opens the model picker with the stored value and writes the picked model', async () => {
    preference.enabled = true;
    const renderer = await mountScreen();

    const row = findConfigureRow(renderer, 'Model');
    act(() => {
      (row.props.onPress as () => void)();
    });

    expect(openModelPicker).toHaveBeenCalledTimes(1);
    const [calledRouter, params] = lastPickerCall();
    expect(calledRouter).toBe(router);
    // The translation model has no reasoning effort, so the picker rows drop
    // the catalogue's gateway variants: that is what makes the shared picker
    // commit and close on tap instead of demanding a variant then Done.
    expect(params).toMatchObject({
      options: MODELS.map(candidate => withoutVariants(candidate)),
      value: 'kilo-auto/small',
      variant: '',
    });

    act(() => {
      params.onSelect('kilo-auto/frontier');
    });
    expect(preference.setModel).toHaveBeenCalledWith({
      id: 'kilo-auto/frontier',
      name: 'Auto Frontier',
    });
  });

  it('falls back to the picked id as the model name when the catalogue lacks it', async () => {
    preference.enabled = true;
    const renderer = await mountScreen();

    const row = findConfigureRow(renderer, 'Model');
    act(() => {
      (row.props.onPress as () => void)();
    });

    const [, params] = lastPickerCall();
    act(() => {
      params.onSelect('kilo-auto/unknown');
    });
    expect(preference.setModel).toHaveBeenCalledWith({
      id: 'kilo-auto/unknown',
      name: 'kilo-auto/unknown',
    });
  });

  it('keeps the switch disabled until the preference has loaded', async () => {
    preference.hasLoaded = false;
    const renderer = await mountScreen();

    expect(findPreferenceRow(renderer).props.disabled).toBe(true);
  });

  it('keeps an unavailable stored model, keeps the row enabled, and shows the picker notice', async () => {
    preference.enabled = true;
    preference.model = { id: 'kilo-auto/retired', name: 'Auto Retired' };
    const renderer = await mountScreen();

    // The row names the kept model and stays tappable: the picker is the fix.
    expect(findConfigureRow(renderer, 'Model').props).toMatchObject({
      subtitle: 'Auto Retired',
      disabled: false,
    });
    expect(findTexts(renderer)).toContain(
      'This model is no longer offered. Tap Model to choose another.'
    );
    // A retry cannot restore a dropped model, so no error state/retry renders.
    expect(findQueryErrors(renderer)).toHaveLength(0);
  });

  it('shows no unavailable notice while the stored model is still offered', async () => {
    preference.enabled = true;
    preference.model = { id: 'kilo-auto/frontier', name: 'Auto Frontier' };
    const renderer = await mountScreen();

    expect(findConfigureRow(renderer, 'Model').props).toMatchObject({
      subtitle: 'Auto Frontier',
      disabled: false,
    });
    expect(findTexts(renderer)).not.toContain(
      'This model is no longer offered. Tap Model to choose another.'
    );
  });
});
