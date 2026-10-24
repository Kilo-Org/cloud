import { createElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';
import { BriefingContextSettings } from './briefing-context-settings';
import { ScheduleSettings } from './briefing-schedule-settings';

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  mutationOptions: [] as Record<string, unknown>[],
}));

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  Platform: { OS: 'android' },
  Switch: 'Switch',
  View: 'View',
}));
vi.mock('@expo/ui/community/datetime-picker', () => ({ DateTimePicker: 'NativeDateTimePicker' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'hi', resolvedLanguage: 'hi' },
  }),
}));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key, language: 'hi' } }));
vi.mock('sonner-native', () => ({ toast: { error: h.error, success: vi.fn() } }));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: h.success, error: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/agents/model-selector', () => ({ ModelSelector: 'ModelSelector' }));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({ useOfflineBannerState: () => false }));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => ({
    models: [{ id: 'default-model' }],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: Record<string, unknown>) => {
    h.mutationOptions.push(options);
    return { mutate: h.mutate, isPending: false };
  },
  useQuery: () => ({
    data: { canGenerate: false, unavailableReason: 'insufficient_history' },
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useQueryClient: () => ({
    cancelQueries: vi.fn(),
    getQueriesData: () => [],
    setQueriesData: vi.fn(),
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
  }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    agentBriefing: {
      updatePreferences: { mutationOptions: (options: unknown) => options },
      updateContextPreferences: { mutationOptions: (options: unknown) => options },
      preferences: { pathKey: () => ['briefing', 'preferences'] },
      estimateSummary: { queryOptions: (input: unknown) => input },
    },
  }),
}));

type Rendered = TestRenderer.ReactTestRenderer;
type Node = TestRenderer.ReactTestInstance;

/** Night and morning do not overlap, so the schedule is savable. */
const preferences = {
  timezone: 'Asia/Kolkata',
  nightStart: '22:00',
  morningStart: '08:00',
  morningEnd: '12:00',
  language: 'hi',
  notificationsEnabled: true,
  defaultModel: 'default-model',
  contexts: [],
};

const contextPreference = {
  context: { id: 'ctx-1', organizationId: null, name: '' },
  aiEnabled: false,
  model: 'default-model',
  maxDurationSeconds: 600,
  maxSpendMicrodollars: 1_000_000,
};

function mount(element: ReactElement): Rendered {
  const holder: { renderer?: Rendered } = {};
  act(() => {
    holder.renderer = TestRenderer.create(element);
  });
  if (!holder.renderer) {
    throw new Error('component is not mounted');
  }
  return holder.renderer;
}

function byType(renderer: Rendered, type: string): Node[] {
  return renderer.root.findAll(node => (node.type as string) === type);
}

function press(node: Node): void {
  const { onPress } = node.props as { onPress: () => void };
  act(() => {
    onPress();
  });
}

/** The Save button closes the schedule form. */
function pressSave(renderer: Rendered): void {
  const save = byType(renderer, 'Button').at(-1);
  if (!save) {
    throw new Error('Save button is missing');
  }
  press(save);
}

function confirmSaved(): void {
  const [options] = h.mutationOptions;
  const onSuccess = options?.onSuccess as (() => void) | undefined;
  if (!onSuccess) {
    throw new Error('the save mutation has no success handler');
  }
  act(() => {
    onSuccess();
  });
}

afterEach(() => {
  vi.clearAllMocks();
  h.mutationOptions.length = 0;
});

describe('briefing schedule save confirmation', () => {
  it('confirms the save once the mutation succeeds', () => {
    const renderer = mount(createElement(ScheduleSettings, { preferences }));
    pressSave(renderer);
    expect(h.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ nightStart: '22:00', morningStart: '08:00', morningEnd: '12:00' })
    );
    expect(h.success).not.toHaveBeenCalled();
    confirmSaved();
    expect(h.success).toHaveBeenCalledTimes(1);
    expect(h.success).toHaveBeenCalledWith('agentBriefing.saved');
    expect(h.error).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });

  it('shows only the invalid-schedule error when the window is empty', () => {
    const renderer = mount(
      createElement(ScheduleSettings, { preferences: { ...preferences, morningStart: '22:00' } })
    );
    pressSave(renderer);
    expect(h.mutate).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledTimes(1);
    expect(h.success).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });
});

describe('briefing AI-settings save confirmation', () => {
  it('confirms after the summaries switch is turned off', () => {
    const renderer = mount(
      createElement(BriefingContextSettings, {
        preference: contextPreference,
        defaultModel: 'default-model',
      })
    );
    const [toggle] = byType(renderer, 'Switch');
    if (!toggle) {
      throw new Error('summaries switch is missing');
    }
    const { onValueChange } = toggle.props as { onValueChange: (next: boolean) => void };
    act(() => {
      onValueChange(false);
    });
    expect(h.mutate).toHaveBeenCalledWith({ organizationId: undefined, aiEnabled: false });
    confirmSaved();
    expect(h.success).toHaveBeenCalledTimes(1);
    expect(h.success).toHaveBeenCalledWith('agentBriefing.saved');
    act(() => {
      renderer.unmount();
    });
  });
});
