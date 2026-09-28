import { act, type ReactTestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import {
  findConfigureRow,
  findQueryErrors,
} from '@/components/tool-summary-translation-settings-screen.mounted.test-helpers';
import { ToolSummaryTranslationSettingsScreen } from '@/components/tool-summary-translation-settings-screen';
import { type ModelOption } from '@/lib/hooks/use-available-models';
import { renderWithProviders } from '@/test/render-with-providers';

const preference = vi.hoisted(() => ({
  enabled: false,
  model: { id: 'kilo-auto/small', name: 'Auto Small' },
  hasLoaded: true,
  setEnabled: vi.fn<(next: boolean) => void>(),
  setModel: vi.fn<(next: { id: string; name: string }) => void>(),
}));
// The catalogue flags the retry cases drive: TanStack Query v5 clears `isError`
// and sets `isLoading` on a no-data refetch, so `isFetched` is what tells the
// screen that the pending state is a retry of a failed catalogue (e17).
const modelsState = vi.hoisted(() => ({
  models: [] as ModelOption[],
  isLoading: false,
  isError: false,
  isFetching: false,
  isFetched: true,
  refetch: vi.fn<() => void>(),
}));

vi.mock('react-native', () => ({
  Switch: 'Switch',
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
  modelsState.models = [];
  modelsState.isLoading = false;
  modelsState.isError = false;
  modelsState.isFetching = false;
  modelsState.isFetched = true;
  modelsState.refetch = vi.fn<() => void>();
});
afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe('ToolSummaryTranslationSettingsScreen catalogue retry', () => {
  // TanStack Query v5 resets a no-data refetch to pending: `isError` clears and
  // `isLoading` turns true, so `isError` alone drops the error block (and its
  // Retry) the instant the user taps it. The screen keeps the failed state
  // through the refetch, so the block stays and its Retry is busy until the
  // request settles. `className: 'pt-0'` anchors the block directly below the
  // model row instead of the `placement="top"` gap (e11 spot check).
  it('keeps the failed block with the Retry busy while the catalogue refetches', async () => {
    // The real refetch-from-error state: error cleared, query back to pending.
    modelsState.isError = false;
    modelsState.isLoading = true;
    modelsState.isFetching = true;
    modelsState.isFetched = true;
    const renderer = await mountScreen();

    const states = findQueryErrors(renderer);
    expect(states).toHaveLength(1);
    expect(states[0]?.props).toMatchObject({
      title: 'Could not load models',
      isRetrying: true,
      className: 'pt-0',
    });
    // One loading indicator: the row stays neutral while the busy Retry carries it.
    expect(findConfigureRow(renderer, 'Model').props).toMatchObject({
      subtitle: '—',
      disabled: true,
    });
  });

  // An empty catalogue keeps its data (`[]`) across a refetch, so TanStack does
  // not reset it to pending and `isLoading` stays false.
  it('keeps the empty block with the Retry busy while the catalogue refetches', async () => {
    modelsState.isError = false;
    modelsState.isLoading = false;
    modelsState.isFetching = true;
    modelsState.isFetched = true;
    const renderer = await mountScreen();

    const states = findQueryErrors(renderer);
    expect(states).toHaveLength(1);
    expect(states[0]?.props).toMatchObject({
      title: 'No models available',
      isRetrying: true,
      className: 'pt-0',
    });
  });
});
