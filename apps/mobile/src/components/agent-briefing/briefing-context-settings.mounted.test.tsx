import { createElement } from 'react';
import { expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { BriefingContextSettings } from './briefing-context-settings';

/**
 * The AI block's switch is the control that spends money, so it has to be the
 * one thing a screen reader names: the row's own label plus its on/off state.
 * The explorer reported the section heading as the switch's name, which reads
 * as "AI settings · Personal" with no indication of what the control does. The
 * catalogue keys are stubbed with their English copy so the assertions read as
 * the sentence a person hears.
 */
const COPY: Readonly<Record<string, string>> = {
  'agentBriefing.aiOptIn': 'Paid AI summaries',
  'agentBriefing.aiHint': 'Optional for this context.',
  'agentBriefing.contextSettings': 'AI settings · {{context}}',
  'common.personal': 'Personal',
  'common.couldNotLoadModels': 'Could not load models',
  'agentBriefing.defaultModel': 'Use the default model',
  'agentBriefing.duration': 'Time limit (minutes)',
  'agentBriefing.spendLimit': 'Spend limit (USD)',
  'agentBriefing.safeguardHint': 'Per-summary limits.',
  'agentBriefing.invalidSafeguards': 'Invalid limits',
  'agentBriefing.enablePaid': 'Enable paid summaries',
  'common.retry': 'Retry',
};

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  Platform: { OS: 'android' },
  Switch: 'Switch',
  View: 'View',
}));
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
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQuery: () => ({ data: undefined, isError: false, isFetching: false, refetch: vi.fn() }),
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
  aiEnabled: true,
  model: 'model-a',
  maxDurationSeconds: 600,
  maxSpendMicrodollars: 2_000_000,
} as const;

function mount(aiEnabled: boolean) {
  const holder: { renderer?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    holder.renderer = TestRenderer.create(
      createElement(BriefingContextSettings, {
        preference: { ...preference, aiEnabled },
        defaultModel: 'model-a',
      })
    );
  });
  const mounted = holder.renderer;
  if (!mounted) {
    throw new Error('Settings block is not mounted');
  }
  return mounted;
}

it('names the paid summaries switch after its row and reports that it is on', () => {
  const mounted = mount(true);
  const switchNode = mounted.root.find(node => (node.type as string) === 'Switch');
  const props: { accessibilityLabel?: string; accessibilityState?: { checked?: boolean } } =
    switchNode.props;

  expect(props.accessibilityLabel).toBe('Paid AI summaries');
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
