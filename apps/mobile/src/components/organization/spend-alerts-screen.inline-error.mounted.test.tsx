// The spend view's live-disabled Save, judged on what a person can read: the
// real field, the real validators, and the screen's own change wiring. The
// sibling suite mocks `FormField` as a host name to assert wiring, so this one
// leaves it unmocked and requires the message to reach the input's composed
// accessibility label, which the reserved copy never populates.

import { createElement } from 'react';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { SpendAlertsScreen } from '@/components/organization/spend-alerts-screen';
import { thresholdError } from '@/components/organization/spend-alert-validators';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

const getQueryFn = vi.hoisted(() => vi.fn());
const saveMutationFn = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn() }));
const boundary = vi.hoisted(() => ({
  organizationId: undefined as string | undefined,
  role: 'owner',
  org: null as { organizationId: string } | null,
  isResolving: false,
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    spendAlerts: {
      get: {
        queryOptions: (input: Record<string, unknown>, options: Record<string, unknown> = {}) => ({
          queryKey: ['spendAlerts', 'get', input],
          queryFn: getQueryFn,
          ...options,
        }),
        pathFilter: () => ({ queryKey: [['spendAlerts', 'get']] }),
      },
      save: {
        mutationOptions: (options: Record<string, unknown> = {}) => ({
          ...options,
          mutationFn: saveMutationFn,
          mutationKey: ['spendAlerts', 'save'],
        }),
      },
    },
  }),
}));
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(),
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  useColorScheme: () => 'light',
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Switch: 'Switch',
  TextInput: 'TextInput',
  View: 'View',
}));
vi.mock('@/components/organization/organization-boundary', () => ({
  OrganizationBoundary: 'OrganizationBoundary',
}));
vi.mock('@/components/organization/permission-denied', () => ({
  PermissionDenied: 'PermissionDenied',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronRight: 'DirectionalChevronRight',
}));
vi.mock('@/components/ui/kv-row', () => ({ KvRow: 'KvRow' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/a11y/status-announcement', () => ({ useStatusAnnouncement: vi.fn() }));
vi.mock('@/lib/hooks/use-organization-queries', () => ({ useOrgBoundary: () => boundary }));
vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({
  useRouteForegroundRefresh: vi.fn(),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666666' }),
}));
vi.mock('@/lib/format', () => {
  const normalizeLocalizedNumber = (value: string) => {
    const normalized = value.trim().replaceAll(',', '');
    return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized) ? normalized : null;
  };
  return {
    formatPrefixedMoney: (amount: number) => `$${amount}`,
    formatPrefixedUsd: (amount: number, _locale: string, options: Intl.NumberFormatOptions = {}) =>
      `$${amount.toLocaleString('en-US', options)}`,
    formatCurrency: (amount: number) => `$${amount}`,
    formatNumber: String,
    formatList: (values: readonly string[]) => values.join(' and '),
    normalizeLocalizedNumber,
    parseLocalizedNumber: (value: string) => {
      const normalized = normalizeLocalizedNumber(value);
      if (normalized === null) {
        return null;
      }
      const parsed = Number(normalized);
      return Number.isFinite(parsed) ? parsed : null;
    },
  };
});

function thresholdRule() {
  return {
    kind: 'threshold',
    enabled: true,
    threshold: 25,
    windowHours: 24,
    multiplierBasisPoints: null,
    emailEnabled: true,
    pushEnabled: false,
    firing: false,
  };
}

function anomalyRule() {
  return {
    kind: 'anomaly',
    enabled: true,
    threshold: null,
    windowHours: null,
    multiplierBasisPoints: 200,
    emailEnabled: true,
    pushEnabled: false,
    firing: false,
  };
}

function settingsFixture() {
  return {
    scope: 'personal',
    scopeName: 'Ada',
    canManage: true,
    pushCategoryEnabled: true,
    pushChannelBlocked: false,
    enabled: true,
    rules: [thresholdRule(), anomalyRule()],
    spend: {
      spend24hMicrodollars: 1_500_000,
      spend7dMicrodollars: 2_000_000,
      baselineHourlyMicrodollars: null,
    },
  };
}

function collectText(node: unknown): string[] {
  if (node == null || typeof node === 'boolean') {
    return [];
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return [String(node)];
  }
  if (Array.isArray(node)) {
    return node.flatMap(item => collectText(item));
  }
  if (typeof node === 'object' && 'children' in node) {
    return collectText((node as { children?: unknown }).children);
  }
  return [];
}

function texts(renderer: ReactTestRenderer): string[] {
  return collectText(renderer.toJSON());
}

function byType(renderer: ReactTestRenderer, nodeType: string): ReactTestInstance[] {
  return renderer.root.findAll(node => node.type === nodeType);
}

function inputByLabel(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const input = byType(renderer, 'TextInput').find(node =>
    String(node.props.accessibilityLabel).startsWith(label)
  );
  if (!input) {
    throw new Error(`TextInput for ${label} not found`);
  }
  return input;
}

function saveButton(renderer: ReactTestRenderer): ReactTestInstance {
  const button = byType(renderer, 'Button').find(node => node.props.variant === undefined);
  if (!button) {
    throw new Error('Save button not found');
  }
  return button;
}

const LIMIT = i18n.t('spendAlerts.limitLabel');

async function mountLoaded() {
  getQueryFn.mockResolvedValue(settingsFixture());
  const view = await renderWithProviders(createElement(SpendAlertsScreen, {}));
  await waitFor(() => texts(view.renderer).includes(i18n.t('spendAlerts.subtitle')));
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  boundary.organizationId = undefined;
  boundary.org = null;
  boundary.isResolving = false;
  saveMutationFn.mockResolvedValue(settingsFixture());
});

describe('SpendAlertsScreen limit above the maximum', () => {
  it('names the maximum while Save stays disabled, with no blur', async () => {
    const { renderer } = await mountLoaded();
    // The cap is the validator's own bound, so the expectation is what the real
    // rule produces rather than a string this test builds by hand.
    const expectedMaxError = thresholdError('1000001');
    if (expectedMaxError === null) {
      throw new Error('the limit rule reported nothing above the maximum');
    }

    // The renderer exposes props as an untyped record; the shared field wires this handler.
    const limitInput = inputByLabel(renderer, LIMIT).props as {
      onChangeText: (value: string) => void;
    };
    act(() => {
      limitInput.onChangeText('1000001');
    });
    expect(saveButton(renderer).props.disabled).toBe(true);

    // The window press is the tap that used to explain nothing: the field is
    // never blurred, so only the field's own rule can say what is wrong.
    const windowControl = byType(renderer, 'SegmentedControl')[0];
    if (!windowControl) {
      throw new Error('window SegmentedControl not found');
    }
    const windowPicker = windowControl.props as { onChange: (value: string) => void };
    act(() => {
      windowPicker.onChange('168');
    });

    // The reserve set keeps an invisible copy of every message the rule can
    // show, so rendered text cannot prove the rule fired. The composed label
    // carries the visible state: label, required, then the message.
    expect(String(inputByLabel(renderer, LIMIT).props.accessibilityLabel)).toContain(
      expectedMaxError
    );
    expect(saveButton(renderer).props.disabled).toBe(true);
  });
});
