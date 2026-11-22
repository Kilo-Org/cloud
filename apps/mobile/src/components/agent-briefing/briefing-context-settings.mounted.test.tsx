/* eslint-disable max-lines -- one mock harness pins the quote line's phases and both enable-flow exits; a second file would duplicate the react-native and tRPC mocks */
import { createElement } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
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
  'agentBriefing.estimateLoadError': "Couldn't load the estimate.",
  'agentBriefing.enablePaid': 'Enable paid summaries',
  'common.retry': 'Retry',
};

const paid = vi.hoisted(() => ({
  mutate: vi.fn(),
  refetch: vi.fn(),
  alert: vi.fn(),
  estimate: { value: undefined as unknown },
  read: { offline: false, isError: false, isFetching: false },
  catalog: { isError: false, refetch: vi.fn() },
  appState: { currentState: 'active' },
}));

beforeEach(() => {
  vi.clearAllMocks();
  paid.estimate.value = undefined;
  paid.read = { offline: false, isError: false, isFetching: false };
  paid.catalog = { isError: false, refetch: vi.fn() };
  paid.appState.currentState = 'active';
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
  AppState: {
    get currentState() {
      return paid.appState.currentState;
    },
  },
  Platform: { OS: 'android' },
  useColorScheme: () => 'light',
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
  // The component only hands this to the real hook, which the mock replaces.
  keepPreviousData: (previous: unknown) => previous,
  useMutation: () => ({ mutate: paid.mutate, isPending: false }),
  useQuery: () => ({
    data: paid.estimate.value,
    isError: paid.read.isError,
    isFetching: paid.read.isFetching,
    refetch: paid.refetch,
  }),
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
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/card', () => ({ Card: 'Card' }));
vi.mock('@/lib/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));

vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
// The status component's announcement bridge imports the native accessibility
// module this harness does not mock; the node's props carry what it renders.
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/agents/model-selector', () => ({ ModelSelector: 'ModelSelector' }));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => ({
    models: [],
    isLoading: false,
    isError: paid.catalog.isError,
    refetch: paid.catalog.refetch,
  }),
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useOfflineBannerState: () => paid.read.offline,
}));

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

it('hides the previous estimate when a field no longer parses', () => {
  paid.estimate.value = {
    canGenerate: true,
    estimatedCostMicrodollars: 1000,
    maximumCostMicrodollars: 2_000_000,
    maxDurationSeconds: 600,
    estimateToken: 'stale-quote',
  };
  const mounted = mount(true);
  expect(JSON.stringify(mounted.toJSON())).toContain('agentBriefing.estimate');

  const [durationField, spendField] = mounted.root.findAll(
    node => (node.type as string) === 'FormField'
  );
  if (!durationField || !spendField) {
    throw new Error('missing safeguard field');
  }
  act(() => {
    (durationField.props.onChangeText as (value: string) => void)('not a duration');
  });

  // The sentence now lives on the field at fault; the spend field, which still
  // parses, carries no error of its own.
  const durationProps = durationField.props as { error?: string; reserveErrorMessages?: string[] };
  const spendProps = spendField.props as { error?: string };
  expect(durationProps.error).toBe('Invalid limits');
  expect(durationProps.reserveErrorMessages).toEqual(['Invalid limits']);
  expect(spendProps.error).toBeUndefined();

  // The line keeps no visible copy in this phase: one announce-only status, so
  // the end of the wait is still spoken.
  const statuses = mounted.root.findAll(node => (node.type as string) === 'AccessibleStatus');
  expect(statuses).toHaveLength(1);
  expect(statuses[0]?.props.message).toBe('Invalid limits');
  expect(statuses[0]?.props.className).toContain('absolute');

  const tree = JSON.stringify(mounted.toJSON());
  expect(tree).not.toContain('agentBriefing.estimate');
  expect(tree).not.toContain('stale-quote');

  act(() => {
    mounted.unmount();
  });
});

it('keeps the settled quote and the primary action while a keystroke re-reads', () => {
  paid.estimate.value = {
    canGenerate: true,
    estimatedCostMicrodollars: 1000,
    maximumCostMicrodollars: 2_000_000,
    maxDurationSeconds: 600,
    estimateToken: 'kept-quote',
  };
  const mounted = mount(true);
  // A new query key is in flight; the previous quote is what the card holds.
  paid.read = { offline: false, isError: false, isFetching: true };
  const [durationField] = mounted.root.findAll(node => (node.type as string) === 'FormField');
  if (!durationField) {
    throw new Error('missing duration field');
  }
  act(() => {
    (durationField.props.onChangeText as (value: string) => void)('5');
  });

  const tree = JSON.stringify(mounted.toJSON());
  expect(tree).toContain('agentBriefing.estimate');
  expect(tree).not.toContain('"Skeleton"');
  // The reserved error line is a prop, not a rendered error: neither field
  // reports a problem for a value that still parses.
  const fields = mounted.root.findAll(node => (node.type as string) === 'FormField');
  expect(fields.map(field => field.props.error)).toEqual([undefined, undefined]);

  // Nothing else offers an action here: no catalog failure, no default-model
  // link, no failed-estimate Retry.
  const buttons = mounted.root.findAll(node => (node.type as string) === 'Button');
  expect(buttons).toHaveLength(1);
  const primaryProps = buttons[0]?.props as { disabled?: boolean; loading?: boolean };
  expect(primaryProps.disabled).toBe(false);
  expect(primaryProps.loading).toBe(false);

  act(() => {
    mounted.unmount();
  });
});

it('does not call the switch busy for a refetch behind a settled quote', () => {
  paid.estimate.value = {
    canGenerate: true,
    estimatedCostMicrodollars: 1000,
    maximumCostMicrodollars: 2_000_000,
    maxDurationSeconds: 600,
    estimateToken: 'kept-quote',
  };
  paid.read = { offline: false, isError: false, isFetching: true };
  const mounted = mount(true);
  const settled = mounted.root.find(node => (node.type as string) === 'Switch').props as {
    accessibilityState?: { busy?: boolean };
  };
  expect(settled.accessibilityState?.busy).toBe(false);
  act(() => {
    mounted.unmount();
  });

  // The first load is the wait the card does own, so it still announces busy.
  paid.estimate.value = undefined;
  const firstLoad = mount(true);
  const waiting = firstLoad.root.find(node => (node.type as string) === 'Switch').props as {
    accessibilityState?: { busy?: boolean };
  };
  expect(waiting.accessibilityState?.busy).toBe(true);
  act(() => {
    firstLoad.unmount();
  });
});

it('names the model catalog failure and offers Retry as its own control', () => {
  paid.catalog = { isError: true, refetch: vi.fn() };
  const mounted = mount(true);
  const tree = JSON.stringify(mounted.toJSON());
  expect(tree).toContain('Could not load models');
  expect(tree).toContain('Retry');

  const retry = mounted.root
    .findAll(node => (node.type as string) === 'Button')
    .find(
      node =>
        node.findAll(child => (child.type as string) === 'Text')[0]?.props.children === 'Retry'
    );
  if (!retry) {
    throw new Error('missing catalog retry');
  }
  // The control's name is the action, not the sentence above it.
  expect(retry.findAll(node => (node.type as string) === 'Text')).toHaveLength(1);
  const retryProps = retry.props as { onPress: () => void };
  act(() => {
    retryProps.onPress();
  });
  expect(paid.catalog.refetch).toHaveBeenCalledTimes(1);

  act(() => {
    mounted.unmount();
  });
});

it('requires a fresh cost confirmation before explicitly enabling scheduled capture', async () => {
  const mounted = mount(false);
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

it('declines a confirm press whose attempt no longer owns the card', async () => {
  const mounted = mount(false);
  const switchNode = mounted.root.find(node => (node.type as string) === 'Switch');
  const { onValueChange } = switchNode.props as { onValueChange: (next: boolean) => void };
  act(() => {
    onValueChange(true);
  });
  await waitFor(() => paid.alert.mock.calls.length === 1);
  // The card unmounted: the surface store's invalidateAll killed the attempt,
  // so the dialog's Enable press must not fire the paid write.
  act(() => {
    mounted.unmount();
  });
  const buttons = paid.alert.mock.calls[0]?.[2] as { onPress?: () => void }[];
  act(() => {
    buttons[1]?.onPress?.();
  });
  expect(paid.mutate).not.toHaveBeenCalled();
});

it('names connectivity instead of a wait when the estimate read is disabled offline', () => {
  // No data, no error, nothing in flight: a disabled read never settles, so
  // the loading placeholder would claim a wait that never ends.
  paid.estimate.value = undefined;
  paid.read = { offline: true, isError: false, isFetching: false };
  const mounted = mount(true);

  const tree = JSON.stringify(mounted.toJSON());
  expect(tree).toContain('offline.noInternet');
  expect(tree).not.toContain('common.loading');
  expect(tree).not.toContain('agentBriefing.estimateUnavailable');

  act(() => {
    mounted.unmount();
  });
});

it('names the failed read instead of a wait when the quote errors with no cache', () => {
  paid.estimate.value = undefined;
  paid.read = { offline: false, isError: true, isFetching: false };
  const mounted = mount(true);

  const tree = JSON.stringify(mounted.toJSON());
  expect(tree).toContain("Couldn't load the estimate.");
  expect(tree).not.toContain('common.loading');

  act(() => {
    mounted.unmount();
  });
});

it('keeps a cached quote when connectivity drops', () => {
  // A disabled query keeps the data of its last successful read, so the card
  // still holds a quote the line must show instead of the offline note.
  paid.estimate.value = {
    canGenerate: true,
    estimatedCostMicrodollars: 1000,
    maximumCostMicrodollars: 2_000_000,
    maxDurationSeconds: 600,
    estimateToken: 'cached-quote',
  };
  paid.read = { offline: true, isError: false, isFetching: false };
  const mounted = mount(true);

  const tree = JSON.stringify(mounted.toJSON());
  expect(tree).toContain('agentBriefing.estimate');
  expect(tree).not.toContain('offline.noInternet');

  act(() => {
    mounted.unmount();
  });
});

it('names the estimate read failure, not the briefs copy, when nothing is cached', () => {
  paid.estimate.value = undefined;
  paid.read = { offline: false, isError: true, isFetching: false };
  const mounted = mount(true);

  const tree = JSON.stringify(mounted.toJSON());
  expect(tree).toContain("Couldn't load the estimate.");
  expect(tree).not.toContain('agentBriefing.loadError');

  act(() => {
    mounted.unmount();
  });
});

it('offers Retry only while the failed estimate is the line it shows', () => {
  paid.estimate.value = undefined;
  paid.read = { offline: false, isError: true, isFetching: false };
  const mounted = mount(true);
  expect(JSON.stringify(mounted.toJSON())).toContain('Retry');

  const [durationField] = mounted.root.findAll(node => (node.type as string) === 'FormField');
  if (!durationField) {
    throw new Error('missing duration field');
  }
  // An unparsable field disables the query, so the field at fault reads
  // `Invalid limits` and the Retry beside the line would refetch a query that
  // cannot run.
  act(() => {
    (durationField.props.onChangeText as (value: string) => void)('not a duration');
  });
  const invalidTree = JSON.stringify(mounted.toJSON());
  expect(invalidTree).toContain('Invalid limits');
  expect(invalidTree).not.toContain('Retry');
  act(() => {
    mounted.unmount();
  });

  paid.read = { offline: true, isError: true, isFetching: false };
  const offline = mount(true);
  const offlineTree = JSON.stringify(offline.toJSON());
  expect(offlineTree).toContain('offline.noInternet');
  expect(offlineTree).not.toContain('Retry');
  act(() => {
    offline.unmount();
  });
});

it('settles the confirm flow when the dialog is dismissed', async () => {
  const mounted = mount(false);
  const tap = (): void => {
    const node = mounted.root.find(item => (item.type as string) === 'Switch');
    (node.props.onValueChange as (next: boolean) => void)(true);
  };
  act(tap);
  await waitFor(() => paid.alert.mock.calls.length === 1);

  // Android back or an outside tap dismisses the dialog without running a
  // button handler, so the dismissal alone must return the card to idle.
  const options = paid.alert.mock.calls[0]?.[3] as { onDismiss?: () => void } | undefined;
  act(() => {
    options?.onDismiss?.();
  });
  const settled = mounted.root.find(item => (item.type as string) === 'Switch');
  const settledState = settled.props as { accessibilityState?: { busy?: boolean } };
  expect(settledState.accessibilityState?.busy).toBe(false);

  act(tap);
  await waitFor(() => paid.alert.mock.calls.length === 2);
  act(() => {
    mounted.unmount();
  });
});

it('refuses to present the paid confirm while the app is not in front', async () => {
  paid.appState.currentState = 'background';
  const mounted = mount(false);
  const switchNode = mounted.root.find(node => (node.type as string) === 'Switch');
  const { onValueChange } = switchNode.props as { onValueChange: (next: boolean) => void };
  act(() => {
    onValueChange(true);
  });
  await waitFor(() => paid.refetch.mock.calls.length === 1);
  // Presenting the alert here would run no callback at all, so the attempt is
  // abandoned and the card returns to idle for the next tap.
  await act(async () => {
    await Promise.resolve();
  });
  expect(paid.alert).not.toHaveBeenCalled();
  const idle = mounted.root.find(node => (node.type as string) === 'Switch');
  const idleState = idle.props as { accessibilityState?: { busy?: boolean } };
  expect(idleState.accessibilityState?.busy).toBe(false);

  paid.appState.currentState = 'active';
  const active = mounted.root.find(node => (node.type as string) === 'Switch');
  const { onValueChange: onOpen } = active.props as { onValueChange: (next: boolean) => void };
  act(() => {
    onOpen(true);
  });
  await waitFor(() => paid.alert.mock.calls.length === 1);
  act(() => {
    mounted.unmount();
  });
});

it('declines a confirm press after the account changed', async () => {
  const mounted = mount(false);
  const switchNode = mounted.root.find(node => (node.type as string) === 'Switch');
  const { onValueChange } = switchNode.props as { onValueChange: (next: boolean) => void };
  act(() => {
    onValueChange(true);
  });
  await waitFor(() => paid.alert.mock.calls.length === 1);
  // The dialog outlived the account it was opened for, so its Enable press must
  // not fire the paid write for a different account's card.
  act(() => {
    bumpAuthEpoch();
  });
  const buttons = paid.alert.mock.calls[0]?.[2] as { onPress?: () => void }[];
  act(() => {
    buttons[1]?.onPress?.();
  });
  expect(paid.mutate).not.toHaveBeenCalled();
  act(() => {
    mounted.unmount();
  });
});
