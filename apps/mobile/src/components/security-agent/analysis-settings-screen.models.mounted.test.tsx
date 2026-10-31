// A catalogue refetch can fail while the last list is still in memory: the app
// reports itself offline (NetInfo holds no reachability) while the backend is
// unreachable, and React Query keeps the previous data on a failed refetch.
// The model rows must stay usable there; the retryable error belongs on the
// screen only when the failure left nothing to show.

import { createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { type ModelOption } from '@/lib/hooks/use-available-models';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { AnalysisSettingsScreen } from './analysis-settings-screen';

const catalog = vi.hoisted(() => ({
  models: [] as ModelOption[],
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));
const config = vi.hoisted(() => ({
  data: null as Record<string, unknown> | null,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));

function enabledConfig(): Record<string, unknown> {
  return {
    isEnabled: true,
    triageModelSlug: 'vendor/triage',
    analysisModelSlug: 'vendor/analysis',
    remediationModelSlug: 'vendor/remediation',
    analysisMode: 'auto',
  };
}

vi.mock('react-native', () => ({
  View: (props: { children?: ReactNode }): ReactNode => props.children ?? null,
  Pressable: 'Pressable',
  Alert: { alert: vi.fn() },
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentCapability: () => ({ canManage: true }),
  useSecurityAgentConfig: () => config,
  useSaveSecurityAgentConfig: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTrackSecurityAgentInteraction: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => catalog,
}));
vi.mock('@/lib/hooks/use-settings-back-guard', () => ({
  useSecurityAgentSettingsRedirect: () => undefined,
  useSettingsBackGuard: () => ({
    onBack: vi.fn(),
    skipNextGuardRef: { current: false },
    dialog: null,
  }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#000000' }),
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/input', () => ({ Input: 'Input' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
vi.mock('@/components/ui/icons', () => ({ Brain: 'Brain', Search: 'Search', Wrench: 'Wrench' }));
vi.mock('@/components/ui/radio-group', () => ({
  RadioGroup: (props: { children?: ReactNode }): ReactNode => props.children ?? null,
  radioItemA11y: () => ({}),
}));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: ReactNode }): ReactNode => props.children ?? null,
}));
vi.mock('@/components/agents/model-selector', () => ({ openModelPicker: vi.fn() }));
vi.mock('@/components/platform-error-screen', () => ({
  PlatformErrorScreen: 'PlatformErrorScreen',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: { headerRight?: ReactNode }): ReactNode => props.headerRight ?? null,
}));
vi.mock('@/components/security-agent/settings-save-button', () => ({
  SettingsSaveButton: 'SettingsSaveButton',
}));

function hostElements(where: TestRenderer.ReactTestRenderer, type: string) {
  return where.root.findAll(element => element.type === type);
}

async function mountScreen() {
  const created: TestRenderer.ReactTestRenderer[] = [];
  await act(() => {
    created.push(TestRenderer.create(createElement(AnalysisSettingsScreen, { scope: 'personal' })));
  });
  const renderer = created[0];
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

const WARM: ModelOption[] = [
  { id: 'vendor/triage', name: 'Vendor Triage', variants: [], isPreferred: false },
  { id: 'vendor/analysis', name: 'Vendor Analysis', variants: [], isPreferred: false },
  { id: 'vendor/remediation', name: 'Vendor Remediation', variants: [], isPreferred: false },
];

describe('AnalysisSettingsScreen model rows when the catalogue refetch fails', () => {
  beforeEach(() => {
    catalog.models = [];
    catalog.isLoading = false;
    catalog.isError = false;
    config.data = enabledConfig();
  });

  it('keeps the rows from the warm catalogue instead of replacing them with the error', async () => {
    catalog.models = WARM;
    catalog.isError = true;

    const renderer = await mountScreen();

    expect(hostElements(renderer, 'ConfigureRow')).toHaveLength(3);
    expect(hostElements(renderer, 'QueryError')).toHaveLength(0);
    renderer.unmount();
  });

  it('shows the retryable error when the failed read has no catalogue to fall back on', async () => {
    catalog.models = [];
    catalog.isError = true;

    const renderer = await mountScreen();

    expect(hostElements(renderer, 'QueryError')).toHaveLength(1);
    expect(hostElements(renderer, 'ConfigureRow')).toHaveLength(0);
    renderer.unmount();
  });
});

describe('AnalysisSettingsScreen depth picker touch target', () => {
  beforeEach(() => {
    catalog.models = [];
    catalog.isLoading = false;
    catalog.isError = false;
    config.data = enabledConfig();
  });

  // Regression: a depth pill was sized by its `py-2` frame alone and rendered
  // under the design target, so only the label band was tappable. The floor has
  // to be the pill node's own class; `hitSlop` would not move the rect a
  // control-size audit measures.
  it('carries the shared row floor on every depth option', async () => {
    const renderer = await mountScreen();
    const pills = hostElements(renderer, 'Pressable').filter(element =>
      String(element.props.className).includes('rounded-full')
    );

    expect(pills).toHaveLength(3);
    for (const pill of pills) {
      expect(String(pill.props.className).split(' ')).toContain(ROW_TARGET_CLASS);
      expect(pill.props.hitSlop).toBeUndefined();
    }
    renderer.unmount();
  });
});
