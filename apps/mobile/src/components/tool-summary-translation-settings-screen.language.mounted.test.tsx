import { act, type ReactTestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { findConfigureRow } from '@/components/tool-summary-translation-settings-screen.mounted.test-helpers';
import { ToolSummaryTranslationSettingsScreen } from '@/components/tool-summary-translation-settings-screen';
import { type ModelOption } from '@/lib/hooks/use-available-models';
import { renderWithProviders } from '@/test/render-with-providers';

const preference = vi.hoisted(() => ({
  enabled: true,
  model: { id: 'kilo-auto/small', name: 'Auto Small' },
  hasLoaded: true,
  setEnabled: vi.fn<(next: boolean) => void>(),
  setModel: vi.fn<(next: { id: string; name: string }) => void>(),
}));
const modelsState = vi.hoisted(() => ({
  models: [] as unknown[],
  isLoading: false,
  isError: false,
  isFetching: false,
  isFetched: true,
  refetch: undefined as unknown,
}));

vi.mock('react-native', () => ({
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/ui/icons', () => ({ Cpu: 'Cpu', WandSparkles: 'WandSparkles' }));
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
  useOrganization: () => ({ organizationId: 'org-1' }),
}));
vi.mock('@/components/agents/model-selector', () => ({ openModelPicker: vi.fn() }));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => modelsState,
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

/** The gateway catalogue names Kilo's Auto models in English, whatever the app language. */
const MODELS: ModelOption[] = [
  { id: 'kilo-auto/small', name: 'Auto Small', variants: [], isPreferred: true },
  { id: 'kilo-auto/efficient', name: 'Auto Efficient', variants: [], isPreferred: true },
];

let view: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;
async function mountScreen(): Promise<ReactTestRenderer> {
  view = await renderWithProviders(<ToolSummaryTranslationSettingsScreen />);
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  return view.renderer;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.resetAllMocks();
  preference.enabled = true;
  preference.model = { id: 'kilo-auto/small', name: 'Auto Small' };
  preference.hasLoaded = true;
  modelsState.models = MODELS;
});
afterEach(async () => {
  view?.unmount();
  view = undefined;
  await i18n.changeLanguage('en');
});

describe('ToolSummaryTranslationSettingsScreen model row in the app language', () => {
  // The row resolves the stored model the way the picker labels it: the
  // catalogue's English name for a kilo-auto id is never shown beside a
  // localized picker.
  it('names the stored Auto model from the catalog in German', async () => {
    await i18n.changeLanguage('de');
    const renderer = await mountScreen();

    expect(findConfigureRow(renderer, i18n.t('common.model')).props).toMatchObject({
      subtitle: 'Auto Klein',
      disabled: false,
    });
  });

  it('names a picked Auto model in German while storing the catalog name raw', async () => {
    await i18n.changeLanguage('de');
    preference.model = { id: 'kilo-auto/efficient', name: 'Auto Efficient' };
    const renderer = await mountScreen();

    expect(findConfigureRow(renderer, i18n.t('common.model')).props).toMatchObject({
      subtitle: 'Auto Effizient',
    });
    expect(preference.model.name).toBe('Auto Efficient');
  });
});
