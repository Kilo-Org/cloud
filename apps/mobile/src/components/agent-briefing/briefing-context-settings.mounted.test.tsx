import { createElement } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';
import { waitFor } from '@/test/render-with-providers';

import { BriefingContextSettings } from './briefing-context-settings';

const COPY: Readonly<Record<string, string>> = {
  'agentBriefing.scheduledContextEnabled': 'Scheduled briefs',
  'agentBriefing.scheduledContextHint': 'Scheduled for this context.',
  'agentBriefing.scheduledContextSettings': 'Scheduled briefs · {{context}}',
  'common.personal': 'Personal',
  'common.couldNotLoadModels': 'Could not load models',
  'agentBriefing.defaultModel': 'Use the default model',
  'agentBriefing.duration': 'Time limit (minutes)',
  'agentBriefing.spendLimit': 'Spend limit (USD)',
  'agentBriefing.snapshotSafeguards': 'Per-summary limits.',
  'agentBriefing.invalidSafeguards': 'Invalid limits',
  'agentBriefing.enablePaid': 'Enable paid summaries',
  'common.retry': 'Retry',
};

const paid = vi.hoisted(() => ({
  mutate: vi.fn(),
  refetch: vi.fn(),
  alert: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  paid.refetch.mockResolvedValue({
    data: {
      canGenerate: true,
      estimatedCostMicrodollars: 1000,
      maximumCostMicrodollars: 2_000_000,
      maxDurationSeconds: 600,
      estimateToken: 'confirmed-estimate',
    },
  });
});

vi.mock('react-native', () => ({
  Alert: { alert: paid.alert },
  Platform: { OS: 'android' },
  useColorScheme: () => 'light',
  Switch: 'Switch',
  View: 'View',
}));
// The shared Switch reads the theme for its track and thumb; the suites that
// replace `react-native` with a partial factory have no colour scheme, so the
// palette comes from the generated tokens directly.
vi.mock('@/lib/hooks/use-theme-colors', async () => {
  const { lightColors } = await import('@/lib/hooks/theme-colors.generated');
  return { useThemeColors: () => lightColors };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { context?: string }) => {
      const copy = COPY[key] ?? key;
      return params?.context ? copy.replace('{{context}}', params.context) : copy;
    },
    i18n: { language: 'en', resolvedLanguage: 'en' },
  }),
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutate: paid.mutate, isPending: false }),
  useQuery: () => ({ data: undefined, isError: false, isFetching: false, refetch: paid.refetch }),
  useQueryClient: () => ({}),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    agentBriefing: {
      updateContextPreferences: { mutationOptions: () => ({}) },
      estimateSummary: { queryOptions: () => ({ queryKey: ['agentBriefing', 'estimate'] }) },
    },
  }),
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/agents/model-selector', () => ({ ModelSelector: 'ModelSelector' }));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => ({ models: [], isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({ useOfflineBannerState: () => false }));

const preference = {
  context: { id: 'personal', organizationId: null, name: 'Personal' },
  enabled: true,
  model: 'model-a',
  maxDurationSeconds: 600,
  maxSpendMicrodollars: 2_000_000,
} as const;

function mount(enabled: boolean) {
  const holder: { renderer?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    holder.renderer = TestRenderer.create(
      createElement(BriefingContextSettings, {
        preference: { ...preference, enabled },
        defaultModel: 'model-a',
        timezone: 'Europe/Berlin',
      })
    );
  });
  const mounted = holder.renderer;
  if (!mounted) {
    throw new Error('Settings block is not mounted');
  }
  return mounted;
}

it('names the scheduled briefs switch after its row and reports that it is on', () => {
  const mounted = mount(true);
  const switchNode = mounted.root.find(node => (node.type as string) === 'Switch');
  const props: { accessibilityLabel?: string; accessibilityState?: { checked?: boolean } } =
    switchNode.props;

  expect(props.accessibilityLabel).toBe('Scheduled briefs');
  expect(props.accessibilityState?.checked).toBe(true);

  act(() => {
    mounted.unmount();
  });
});

it('reports the off state instead of leaving the switch unstated', () => {
  const mounted = mount(false);
  const switchNode = mounted.root.find(node => (node.type as string) === 'Switch');
  const props: { accessibilityState?: { checked?: boolean } } = switchNode.props;

  expect(props.accessibilityState?.checked).toBe(false);

  act(() => {
    mounted.unmount();
  });
});

it('requires a fresh cost confirmation before explicitly enabling scheduled capture', async () => {
  const mounted = mount(false);
  expect(paid.mutate).not.toHaveBeenCalled();
  const switchNode = mounted.root.find(node => (node.type as string) === 'Switch');
  const { onValueChange } = switchNode.props as { onValueChange: (next: boolean) => void };
  act(() => {
    onValueChange(true);
  });
  await waitFor(() => paid.alert.mock.calls.length === 1);
  expect(paid.refetch).toHaveBeenCalledTimes(1);
  expect(paid.mutate).not.toHaveBeenCalled();
  const buttons = paid.alert.mock.calls[0]?.[2] as { onPress?: () => void }[];
  act(() => {
    buttons[1]?.onPress?.();
  });
  expect(paid.mutate).toHaveBeenCalledWith({
    organizationId: undefined,
    enabled: true,
    timezone: 'Europe/Berlin',
    language: 'en',
    model: 'model-a',
    maxDurationSeconds: 600,
    maxSpendMicrodollars: 2_000_000,
    estimateToken: 'confirmed-estimate',
  });
  act(() => {
    mounted.unmount();
  });
});
