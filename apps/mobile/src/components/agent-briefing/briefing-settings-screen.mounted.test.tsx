import { createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { BriefingSettingsScreen } from './briefing-settings-screen';

const fixture = vi.hoisted(() => {
  const contextPreference = {
    context: { id: 'ctx-1', organizationId: null, name: 'Personal' },
    enabled: true,
    model: 'model-a',
    maxDurationSeconds: 600,
    maxSpendMicrodollars: 1_000_000,
  };
  return {
    contextPreference,
    preferences: {
      timezone: 'Asia/Kolkata',
      nightStart: '22:00',
      morningStart: '08:00',
      morningEnd: '12:00',
      language: 'en',
      notificationsEnabled: true,
      defaultModel: 'model-a',
      contexts: [contextPreference],
    },
  };
});

const state = vi.hoisted(() => ({
  offline: false,
  read: {
    data: undefined as unknown,
    isPending: false,
    isError: false,
    error: undefined as unknown,
    refetch: () => Promise.resolve(),
  },
}));

vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView' }));
vi.mock('expo-router', () => ({}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // The screen's `cn` from `@/lib/utils` imports the i18n instance, whose
  // plugin registration needs the mock to carry this export too.
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/section', () => ({ Section: 'Section' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useOfflineBannerState: () => state.offline,
}));
vi.mock('@/lib/agent-briefing', () => ({
  BRIEFING_PATH: '/(app)/agent-briefing',
  useBriefingAccess: () => ({ enabled: true, canRead: () => true }),
  useBriefingInvalidation: vi.fn(),
  useBriefingPreferences: () => state.read,
}));
// Each card remembers the value its own instance first saw. A card keyed by a
// saved value remounts when that value is saved, so the remembered value would
// follow the new props; a card keyed by its slot keeps the first one.
//
// `react` is imported dynamically because `vi.mock` factories are hoisted above
// the file's static imports, so a static `react` import is not initialised yet.
vi.mock('./briefing-schedule-settings', async () => {
  const React = await import('react');
  type Props = { preferences: { timezone: string } };
  return {
    ScheduleSettings: (props: Props) => {
      const [firstTimezone] = React.useState(() => props.preferences.timezone);
      return React.createElement('ScheduleSettings', { ...props, firstTimezone });
    },
  };
});
vi.mock('./briefing-context-settings', async () => {
  const React = await import('react');
  type Props = { preference: { maxSpendMicrodollars: number } };
  return {
    BriefingContextSettings: (props: Props) => {
      const [firstSpend] = React.useState(() => props.preference.maxSpendMicrodollars);
      return React.createElement('BriefingContextSettings', { ...props, firstSpend });
    },
  };
});
vi.mock('./briefing-notification-toggle', () => ({
  BriefingNotificationToggle: 'BriefingNotificationToggle',
}));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

/** What a mounted screen needs from the preferences read. */
function readOf(data: unknown, overrides: Partial<typeof state.read> = {}) {
  return {
    data,
    isPending: false,
    isError: false,
    error: undefined,
    refetch: () => Promise.resolve(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.offline = false;
  state.read = readOf({ ...fixture.preferences });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

function mount(): TestRenderer.ReactTestRenderer {
  act(() => {
    renderer = TestRenderer.create(createElement(BriefingSettingsScreen));
  });
  const mounted = renderer;
  if (!mounted) {
    throw new Error('Briefing settings did not mount');
  }
  return mounted;
}

/** Re-render with whatever `state.read` now holds, as a refetch would. */
function rerender(): void {
  act(() => {
    renderer?.update(createElement(BriefingSettingsScreen));
  });
}

function getTexts(node: TestRenderer.ReactTestInstance): string[] {
  return node.findAllByType('Text').map(child => String(child.props.children));
}

it('reserves the settings card while the first read is pending', () => {
  state.read = readOf(undefined, { isPending: true });
  const mounted = mount();

  const skeletons = mounted.root.findAllByType('Skeleton');
  expect(skeletons).toHaveLength(1);
  expect(skeletons[0]?.props.className).toBe('h-96 rounded-xl');
  expect(mounted.root.findAllByType('ScrollView')).toHaveLength(0);
  expect(mounted.root.findAllByType('QueryError')).toHaveLength(0);
});

it('says it is offline, not a load failure, while the first read is paused', () => {
  // Paused offline, the read never settles: neither the loading card nor the
  // retry describes it, so connectivity names the state.
  state.offline = true;
  state.read = readOf(undefined, { isPending: true });
  const mounted = mount();

  const errors = mounted.root.findAllByType('QueryError');
  expect(errors).toHaveLength(1);
  expect(errors[0]?.props).toMatchObject({ variant: 'offline' });
  expect(errors[0]?.props.onRetry).toBeUndefined();
  expect(errors[0]?.props.title).toBe('offline.noInternet');
  expect(mounted.root.findAllByType('ScrollView')).toHaveLength(0);
  expect(mounted.root.findAllByType('Skeleton')).toHaveLength(0);
  expect(getTexts(mounted.root)).not.toContain('agentBriefing.loadError');
});

it('renders a rejected read as a permission state with no retry', () => {
  state.read = readOf(undefined, { isError: true, error: { data: { code: 'FORBIDDEN' } } });
  const mounted = mount();

  const errors = mounted.root.findAllByType('QueryError');
  expect(errors).toHaveLength(1);
  // Retrying a rejected read returns the same rejection, so the state offers none.
  expect(errors[0]?.props).toMatchObject({ variant: 'permission' });
  expect(errors[0]?.props.onRetry).toBeUndefined();
  expect(mounted.root.findAllByType('ScrollView')).toHaveLength(0);
});

it('renders the cards in slot order once the preferences arrive', () => {
  const mounted = mount();

  const scrolls = mounted.root.findAllByType('ScrollView');
  expect(scrolls).toHaveLength(1);
  expect(mounted.root.findAllByType('Skeleton')).toHaveLength(0);
  expect(mounted.root.findAllByType('QueryError')).toHaveLength(0);
  const [scroll] = scrolls;
  if (!scroll) {
    throw new Error('Settings body is missing');
  }
  const slotNames = ['ScheduleSettings', 'BriefingNotificationToggle', 'BriefingContextSettings'];
  const order = scroll
    .findAll(child => slotNames.includes(String(child.type)))
    .map(child => String(child.type));
  expect(order).toEqual(slotNames);
});

it('keeps each card mounted when a saved value changes', () => {
  const mounted = mount();
  state.read = readOf({
    ...fixture.preferences,
    timezone: 'Europe/Berlin',
    contexts: [{ ...fixture.contextPreference, maxSpendMicrodollars: 2_000_000 }],
  });
  rerender();

  const [schedule] = mounted.root.findAllByType('ScheduleSettings');
  const scheduleProps = schedule?.props as
    | { preferences: { timezone: string }; firstTimezone: string }
    | undefined;
  expect(scheduleProps?.preferences.timezone).toBe('Europe/Berlin');
  expect(scheduleProps?.firstTimezone).toBe('Asia/Kolkata');
  const [context] = mounted.root.findAllByType('BriefingContextSettings');
  const contextProps = context?.props as
    | { preference: { maxSpendMicrodollars: number }; firstSpend: number }
    | undefined;
  expect(contextProps?.preference.maxSpendMicrodollars).toBe(2_000_000);
  expect(contextProps?.firstSpend).toBe(1_000_000);
});

it('names the offline note from inside the ready settings body', () => {
  state.offline = true;
  const mounted = mount();

  const [scroll] = mounted.root.findAllByType('ScrollView');
  if (!scroll) {
    throw new Error('Cached preferences did not render their body');
  }
  expect(getTexts(scroll)).toContain('agentBriefing.offline');
  expect(mounted.root.findAllByType('QueryError')).toHaveLength(0);
});
