import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';
import { ScheduleSettings } from './briefing-schedule-settings';

const mutate = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({ View: 'View', Platform: { OS: 'android' } }));
vi.mock('@expo/ui/community/datetime-picker', () => ({ DateTimePicker: 'NativeDateTimePicker' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'de', resolvedLanguage: 'de' },
  }),
}));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key, language: 'de' } }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({ useOfflineBannerState: () => false }));
vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutate, isPending: false }),
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
      preferences: { pathKey: () => ['briefing', 'preferences'] },
    },
  }),
}));

type Rendered = TestRenderer.ReactTestRenderer;
type Node = TestRenderer.ReactTestInstance;

const preferences = {
  timezone: 'America/Los_Angeles',
  nightStart: '23:00',
  morningStart: '08:00',
  morningEnd: '12:00',
};

function mount(input: typeof preferences = preferences): Rendered {
  const holder: { renderer?: Rendered } = {};
  act(() => {
    holder.renderer = TestRenderer.create(createElement(ScheduleSettings, { preferences: input }));
  });
  if (!holder.renderer) {
    throw new Error('Schedule settings are not mounted');
  }
  return holder.renderer;
}

function all(renderer: Rendered, type: string): Node[] {
  return renderer.root.findAll(node => (node.type as string) === type);
}

function first(renderer: Rendered, type: string): Node {
  const [node] = all(renderer, type);
  if (!node) {
    throw new Error(`${type} is missing`);
  }
  return node;
}

/** The device-timezone button, then one row per stored time. */
function row(renderer: Rendered, index: number): Node {
  const node = all(renderer, 'Button')[index];
  if (!node) {
    throw new Error(`Row ${index} is missing`);
  }
  return node;
}

function press(node: Node): void {
  const { onPress } = node.props as { onPress: () => void };
  act(() => {
    onPress();
  });
}

function choose(node: Node, date: Date): void {
  const { onValueChange } = node.props as {
    onValueChange: (event: object, date: Date) => void;
  };
  act(() => {
    onValueChange({}, date);
  });
}

function edit(node: Node, value: string): void {
  const { onChangeText } = node.props as { onChangeText: (value: string) => void };
  act(() => {
    onChangeText(value);
  });
}

function renderedTexts(renderer: Rendered): string[] {
  return all(renderer, 'Text')
    .map(node => node.props.children)
    .filter((child): child is string => typeof child === 'string');
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('briefing schedule time rows', () => {
  it('opens the picker on the hour the row shows, in a zone behind UTC', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const renderer = mount();
    press(row(renderer, 1));
    const { value } = first(renderer, 'NativeDateTimePicker').props as { value: Date };
    expect(value.getHours()).toBe(23);
    expect(value.getMinutes()).toBe(0);
    act(() => {
      renderer.unmount();
    });
  });

  it('writes the chosen hour back to the row unchanged', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const renderer = mount();
    press(row(renderer, 1));
    choose(first(renderer, 'NativeDateTimePicker'), new Date(2000, 0, 1, 22, 0));
    expect(renderedTexts(renderer)).toContain('22:00');
    act(() => {
      renderer.unmount();
    });
  });
});

describe('briefing schedule validation', () => {
  it('shows the time zone error inline and sends no mutation', () => {
    const renderer = mount();
    edit(first(renderer, 'FormField'), 'Mitteleuropa/Berlin');
    press(all(renderer, 'Button').at(-1) as Node);
    expect(mutate).not.toHaveBeenCalled();
    const { error } = first(renderer, 'FormField').props as { error?: string };
    expect(error).toBe('agentBriefing.invalidSchedule');
    edit(first(renderer, 'FormField'), 'Europe/Berlin');
    const cleared = first(renderer, 'FormField').props as { error?: string };
    expect(cleared.error).toBeUndefined();
    act(() => {
      renderer.unmount();
    });
  });

  it('shows overlapping periods inline and sends no mutation', () => {
    const renderer = mount();
    press(row(renderer, 1));
    choose(first(renderer, 'NativeDateTimePicker'), new Date(2000, 0, 1, 8, 0));
    press(row(renderer, 2));
    choose(first(renderer, 'NativeDateTimePicker'), new Date(2000, 0, 1, 6, 0));
    press(all(renderer, 'Button').at(-1) as Node);
    expect(mutate).not.toHaveBeenCalled();
    expect(renderedTexts(renderer)).toContain('agentBriefing.invalidSchedule');
    act(() => {
      renderer.unmount();
    });
  });

  it('saves a valid schedule in the active language', () => {
    const renderer = mount();
    press(all(renderer, 'Button').at(-1) as Node);
    expect(mutate).toHaveBeenCalledWith({
      timezone: 'America/Los_Angeles',
      nightStart: '23:00',
      morningStart: '08:00',
      morningEnd: '12:00',
      language: 'de',
    });
    act(() => {
      renderer.unmount();
    });
  });
});
