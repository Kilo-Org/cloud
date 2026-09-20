/* eslint-disable max-lines -- one mounted suite for the spend view's state contract: four load states, the push agreement, and the validators' wiring share one mock harness. */

// The spend view's state contract, driven through the screen's own JSX with the
// tRPC layer mocked: the persisted draft, the saved confirmation, the load and
// save errors (retryable, draft kept), permission denial, the off state, and
// the push channel's agreement with the Notifications screen.

import { createElement } from 'react';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { SpendAlertsScreen } from '@/components/organization/spend-alerts-screen';
import { thresholdError } from '@/components/organization/spend-alert-validators';
import { formatList } from '@/lib/format';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

const getQueryFn = vi.hoisted(() => vi.fn());
const saveMutationFn = vi.hoisted(() => vi.fn());
const announced = vi.hoisted(() => ({ success: vi.fn() }));
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
vi.mock('@/lib/a11y/announcing-toast', () => ({ announcingToast: announced }));
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(),
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('react-native', () => ({
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
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronRight: 'DirectionalChevronRight',
}));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/kv-row', () => ({ KvRow: 'KvRow' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-organization-queries', () => ({ useOrgBoundary: () => boundary }));
vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({
  useRouteForegroundRefresh: vi.fn(),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666666' }),
}));
// Everything the validators need from the formatter, in the en-US shape the
// tests write values in.
vi.mock('@/lib/format', () => ({
  formatMoney: (amount: number) => `$${amount}`,
  formatNumber: String,
  formatList: (values: readonly string[]) => values.join(' and '),
  parseLocalizedNumber: (value: string) => {
    const normalized = value.trim().replaceAll(',', '');
    if (normalized === '') {
      return null;
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  },
}));

type RuleFixture = {
  kind: 'threshold' | 'anomaly';
  enabled: boolean;
  threshold: number | null;
  windowHours: number | null;
  multiplierBasisPoints: number | null;
  emailEnabled: boolean;
  pushEnabled: boolean;
  firing: boolean;
};

function thresholdRule(overrides: Partial<RuleFixture> = {}): RuleFixture {
  return {
    kind: 'threshold',
    enabled: true,
    threshold: 25,
    windowHours: 24,
    multiplierBasisPoints: null,
    emailEnabled: true,
    pushEnabled: false,
    firing: false,
    ...overrides,
  };
}

function anomalyRule(overrides: Partial<RuleFixture> = {}): RuleFixture {
  return {
    kind: 'anomaly',
    enabled: true,
    threshold: null,
    windowHours: null,
    multiplierBasisPoints: 200,
    emailEnabled: true,
    pushEnabled: false,
    firing: false,
    ...overrides,
  };
}

function settingsFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...overrides,
  };
}

async function mountScreen(organizationId?: string) {
  const view = await renderWithProviders(
    createElement(SpendAlertsScreen, organizationId == null ? {} : { organizationId })
  );
  return view;
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

function switchByLabel(renderer: ReactTestRenderer, label: string): ReactTestInstance | undefined {
  return byType(renderer, 'Switch').find(node => node.props.accessibilityLabel === label);
}

/**
 * The Email or Push switches of both cards, in render order. Their label is the
 * channel composed with the card's alert kind, so the lookup matches the
 * channel substring and keeps the cards distinguishable.
 */
function channelSwitches(renderer: ReactTestRenderer, channelKey: string): ReactTestInstance[] {
  const channelLabel = i18n.t(channelKey);
  return byType(renderer, 'Switch').filter(node =>
    String(node.props.accessibilityLabel).includes(channelLabel)
  );
}

function fieldByLabel(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const field = byType(renderer, 'FormField').find(node => node.props.label === label);
  if (!field) {
    throw new Error(`FormField for ${label} not found`);
  }
  return field;
}

function buttonByVariant(renderer: ReactTestRenderer, variant?: string): ReactTestInstance {
  const button = byType(renderer, 'Button').find(node => node.props.variant === variant);
  if (!button) {
    throw new Error(`Button for ${String(variant)} not found`);
  }
  return button;
}

function press(instance: ReactTestInstance | undefined): void {
  if (!instance) {
    throw new Error('pressable not found');
  }
  act(() => {
    (instance.props as { onPress: () => void }).onPress();
  });
}

function retry(instance: ReactTestInstance | undefined): void {
  if (!instance) {
    throw new Error('retry control not found');
  }
  act(() => {
    (instance.props as { onRetry: () => void }).onRetry();
  });
}

function toggle(instance: ReactTestInstance | undefined, value: boolean): void {
  if (!instance) {
    throw new Error('switch not found');
  }
  act(() => {
    (instance.props as { onValueChange: (value: boolean) => void }).onValueChange(value);
  });
}

function type(renderer: ReactTestRenderer, label: string, value: string): void {
  const field = fieldByLabel(renderer, label);
  act(() => {
    (field.props as { onChangeText: (value: string) => void }).onChangeText(value);
  });
}

const LIMIT = i18n.t('spendAlerts.limitLabel');
const MULTIPLIER = i18n.t('spendAlerts.multiplierLabel');

async function mountLoaded(overrides: Record<string, unknown> = {}) {
  getQueryFn.mockResolvedValue(settingsFixture(overrides));
  const view = await mountScreen();
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

describe('SpendAlertsScreen happy state', () => {
  it('renders the persisted values, the scope spend, and saves the draft', async () => {
    const { renderer } = await mountLoaded();

    expect(fieldByLabel(renderer, LIMIT).props.defaultValue).toBe('25');
    expect(fieldByLabel(renderer, MULTIPLIER).props.defaultValue).toBe('2');
    expect(byType(renderer, 'KvRow')[0]?.props.value).toBe('$1.5');
    expect(switchByLabel(renderer, i18n.t('spendAlerts.enable'))?.props.value).toBe(true);
    expect(switchByLabel(renderer, i18n.t('spendAlerts.thresholdTitle'))?.props.value).toBe(true);
    expect(byType(renderer, 'SegmentedControl')[0]?.props.value).toBe('24');

    press(buttonByVariant(renderer));

    await waitFor(() => saveMutationFn.mock.calls.length === 1);
    expect(saveMutationFn.mock.calls[0]?.[0]).toEqual({
      enabled: true,
      rules: [
        {
          kind: 'threshold',
          enabled: true,
          threshold: 25,
          windowHours: 24,
          emailEnabled: true,
          pushEnabled: false,
        },
        {
          kind: 'anomaly',
          enabled: true,
          multiplierBasisPoints: 200,
          emailEnabled: true,
          pushEnabled: false,
        },
      ],
    });
    // The confirmation is a real Text node on the form, and the screen stays
    // put so it describes the values on screen: a sonner-native toast alone is
    // drawn outside the accessibility hierarchy, so assistive tech (and the
    // on-device digest) never sees it.
    await waitFor(
      () => byType(renderer, 'AccessibleStatus')[0]?.props.message === i18n.t('spendAlerts.saved')
    );
    expect(byType(renderer, 'AccessibleStatus')[0]?.props.tone).toBe('status');
    // The inline status is the single announcement owner: the mutation must
    // not also announce through a toast, or one save speaks (and draws) the
    // confirmation twice.
    expect(announced.success).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();

    // A draft edit clears it: the message never describes superseded values.
    type(renderer, LIMIT, '30');
    expect(byType(renderer, 'AccessibleStatus')[0]?.props.message).toBeNull();
  });

  it('labels each channel switch with its alert kind so the two cards stay distinct', async () => {
    const { renderer } = await mountLoaded();

    const labels = byType(renderer, 'Switch').map(node => String(node.props.accessibilityLabel));
    expect(labels).toContain(
      formatList([i18n.t('spendAlerts.thresholdTitle'), i18n.t('common.email')], i18n.language)
    );
    expect(labels).toContain(
      formatList(
        [i18n.t('spendAlerts.thresholdTitle'), i18n.t('notifications.push')],
        i18n.language
      )
    );
    expect(labels).toContain(
      formatList([i18n.t('spendAlerts.anomalyTitle'), i18n.t('common.email')], i18n.language)
    );
    expect(labels).toContain(
      formatList([i18n.t('spendAlerts.anomalyTitle'), i18n.t('notifications.push')], i18n.language)
    );
    // The OS hierarchy does not group a switch with its card, so no two controls
    // may share a label.
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('shows no confirmation before the first save', async () => {
    const { renderer } = await mountLoaded();

    expect(byType(renderer, 'AccessibleStatus')[0]?.props.message).toBeNull();
  });

  it('shows the spend summary empty copy when the scope has no spend', async () => {
    const { renderer } = await mountLoaded({
      spend: { spend24hMicrodollars: 0, spend7dMicrodollars: 0, baselineHourlyMicrodollars: null },
    });

    expect(byType(renderer, 'KvRow')[0]?.props.value).toBe(i18n.t('spendAlerts.noSpend'));
  });
});

describe('SpendAlertsScreen foreground refresh', () => {
  it('refreshes the spend-alerts query with the tRPC-nested key prefix', async () => {
    await mountLoaded();

    // The stored key is `[['spendAlerts','get'], …]`; the flat `['spendAlerts']`
    // form compares a string against the first element's array and never
    // matches, so the refresh would be a silent no-op.
    expect(vi.mocked(useRouteForegroundRefresh)).toHaveBeenCalledWith([[['spendAlerts']]]);
  });
});

describe('SpendAlertsScreen retryable states', () => {
  it('renders the load error with a retry and fills the form in place after it clears', async () => {
    getQueryFn.mockRejectedValue(new Error('offline'));
    const { renderer } = await mountScreen();

    await waitFor(() => byType(renderer, 'QueryError').length === 1);
    const error = byType(renderer, 'QueryError')[0];
    expect(error?.props.message).toBe(i18n.t('spendAlerts.loadError'));
    expect(typeof error?.props.onRetry).toBe('function');
    expect(byType(renderer, 'Skeleton')).toHaveLength(0);

    getQueryFn.mockResolvedValue(settingsFixture());
    retry(error);

    await waitFor(() => byType(renderer, 'FormField').length === 2);
    expect(fieldByLabel(renderer, LIMIT).props.defaultValue).toBe('25');
  });

  it('keeps the draft and retries after a failed save', async () => {
    const { renderer } = await mountLoaded();
    saveMutationFn.mockRejectedValue(new Error('boom'));

    type(renderer, LIMIT, '30');
    press(buttonByVariant(renderer));

    await waitFor(() => byType(renderer, 'AccessibleStatus')[0]?.props.message != null);
    expect(byType(renderer, 'AccessibleStatus')[0]?.props.message).toBe(
      i18n.t('spendAlerts.saveError')
    );

    const retryButton = buttonByVariant(renderer, 'outline');
    expect(retryButton.props.accessibilityLabel).toBe('Retry');

    saveMutationFn.mockResolvedValue(settingsFixture());
    press(retryButton);

    await waitFor(() => saveMutationFn.mock.calls.length === 2);
    const retried = saveMutationFn.mock.calls[1]?.[0] as { rules: { threshold: number }[] };
    expect(retried.rules[0]?.threshold).toBe(30);
  });

  it('disables Retry when an edit leaves the draft unsubmittable', async () => {
    const { renderer } = await mountLoaded();
    saveMutationFn.mockRejectedValue(new Error('boom'));

    type(renderer, LIMIT, '30');
    press(buttonByVariant(renderer));

    await waitFor(() => byType(renderer, 'AccessibleStatus')[0]?.props.message != null);
    expect(buttonByVariant(renderer, 'outline').props.disabled).toBe(false);

    // The edit revalidates but keeps the failure showing. Retry posts whatever
    // is on screen, so it must not stay tappable for a draft `onSave` would
    // refuse to send: an enabled-looking control that does nothing.
    type(renderer, LIMIT, '0');
    expect(buttonByVariant(renderer, 'outline').props.disabled).toBe(true);

    type(renderer, LIMIT, '40');
    expect(buttonByVariant(renderer, 'outline').props.disabled).toBe(false);
  });
});

describe('SpendAlertsScreen non-retryable states', () => {
  it('renders permission denial for an organization scope the viewer cannot manage', async () => {
    boundary.org = { organizationId: 'org-1' };
    getQueryFn.mockResolvedValue(
      settingsFixture({ scope: 'organization', canManage: false, enabled: undefined })
    );

    const { renderer } = await mountScreen('org-1');

    await waitFor(() => byType(renderer, 'PermissionDenied').length === 1);
    expect(byType(renderer, 'Button')).toHaveLength(0);
    expect(byType(renderer, 'Switch')).toHaveLength(0);
    expect(byType(renderer, 'FormField')).toHaveLength(0);
  });

  it('disables Save and wires the inline error for an out-of-range limit', async () => {
    const { renderer } = await mountLoaded();

    expect(fieldByLabel(renderer, LIMIT).props.validate).toBe(thresholdError);
    expect((fieldByLabel(renderer, LIMIT).props.validate as (value: string) => string)('0')).toBe(
      i18n.t('organization.lowBalanceAlert.thresholdError')
    );

    type(renderer, LIMIT, '0');

    expect(buttonByVariant(renderer).props.disabled).toBe(true);
    type(renderer, LIMIT, '40');
    expect(buttonByVariant(renderer).props.disabled).toBe(false);
  });
});

describe('SpendAlertsScreen with an alert kind switched off', () => {
  it('lets Save pass with a blank limit once the threshold kind is off', async () => {
    const { renderer } = await mountLoaded();

    type(renderer, LIMIT, '');
    expect(buttonByVariant(renderer).props.disabled).toBe(true);

    toggle(switchByLabel(renderer, i18n.t('spendAlerts.thresholdTitle')), false);

    // A switched-off kind stops validating its field and stops gating Save.
    expect(fieldByLabel(renderer, LIMIT).props.validate).toBeUndefined();
    expect(buttonByVariant(renderer).props.disabled).toBe(false);

    press(buttonByVariant(renderer));

    await waitFor(() => saveMutationFn.mock.calls.length === 1);
    const input = saveMutationFn.mock.calls[0]?.[0] as {
      rules: { kind: string; enabled: boolean; threshold: number }[];
    };
    const savedThreshold = input.rules.find(rule => rule.kind === 'threshold');
    expect(savedThreshold?.enabled).toBe(false);
    // The wire still needs a positive limit for the kind: the stand-in fills in.
    expect(savedThreshold?.threshold).toBeGreaterThan(0);
  });

  it('lets Save pass with a blank multiplier once the anomaly kind is off', async () => {
    const { renderer } = await mountLoaded();

    type(renderer, MULTIPLIER, '');
    expect(buttonByVariant(renderer).props.disabled).toBe(true);

    toggle(switchByLabel(renderer, i18n.t('spendAlerts.anomalyTitle')), false);

    expect(fieldByLabel(renderer, MULTIPLIER).props.validate).toBeUndefined();
    expect(buttonByVariant(renderer).props.disabled).toBe(false);

    press(buttonByVariant(renderer));

    await waitFor(() => saveMutationFn.mock.calls.length === 1);
    const input = saveMutationFn.mock.calls[0]?.[0] as {
      rules: { kind: string; enabled: boolean; multiplierBasisPoints: number }[];
    };
    const anomaly = input.rules.find(rule => rule.kind === 'anomaly');
    expect(anomaly?.enabled).toBe(false);
    expect(anomaly?.multiplierBasisPoints).toBeGreaterThanOrEqual(100);
  });

  it('keeps a valid typed limit when the threshold kind is switched off', async () => {
    const { renderer } = await mountLoaded();

    type(renderer, LIMIT, '30');
    toggle(switchByLabel(renderer, i18n.t('spendAlerts.thresholdTitle')), false);
    press(buttonByVariant(renderer));

    await waitFor(() => saveMutationFn.mock.calls.length === 1);
    const input = saveMutationFn.mock.calls[0]?.[0] as { rules: { threshold: number }[] };
    expect(input.rules[0]?.threshold).toBe(30);
  });
});

describe('SpendAlertsScreen empty state', () => {
  it('shows the off copy with the master switch as the only call to action', async () => {
    const { renderer } = await mountLoaded({ enabled: false });

    expect(texts(renderer)).toContain(i18n.t('spendAlerts.empty'));
    expect(byType(renderer, 'Button')).toHaveLength(0);
    expect(byType(renderer, 'FormField')).toHaveLength(0);
    expect(byType(renderer, 'Switch')).toHaveLength(1);

    toggle(switchByLabel(renderer, i18n.t('spendAlerts.enable')), true);

    expect(texts(renderer)).not.toContain(i18n.t('spendAlerts.empty'));
    expect(byType(renderer, 'FormField')).toHaveLength(2);
    expect(byType(renderer, 'Button')).toHaveLength(1);
  });

  it('keeps Save with the switch when it is turned off, so the disable can be posted', async () => {
    const { renderer } = await mountLoaded();

    toggle(switchByLabel(renderer, i18n.t('spendAlerts.enable')), false);

    expect(texts(renderer)).toContain(i18n.t('spendAlerts.empty'));
    expect(byType(renderer, 'FormField')).toHaveLength(0);

    const saveButton = buttonByVariant(renderer);
    expect(saveButton.props.disabled).toBe(false);
    press(saveButton);

    await waitFor(() => saveMutationFn.mock.calls.length === 1);
    expect(saveMutationFn.mock.calls[0]?.[0]).toMatchObject({ enabled: false });
  });

  it('keeps the saved confirmation after a disable save lands', async () => {
    const { renderer, queryClient } = await mountLoaded();

    toggle(switchByLabel(renderer, i18n.t('spendAlerts.enable')), false);
    press(buttonByVariant(renderer));

    await waitFor(() => saveMutationFn.mock.calls.length === 1);
    await waitFor(
      () => byType(renderer, 'AccessibleStatus')[0]?.props.message === i18n.t('spendAlerts.saved')
    );

    // The save's own refetch lands with the stored value now false, so the
    // draft no longer differs and the off branch is the only branch left. The
    // confirmation must survive that: a disable-save is a supported flow, so it
    // gets the same stable 'settings saved' line as the enable path.
    act(() => {
      queryClient.setQueryData(['spendAlerts', 'get', {}], settingsFixture({ enabled: false }));
    });

    expect(texts(renderer)).toContain(i18n.t('spendAlerts.empty'));
    expect(byType(renderer, 'AccessibleStatus')[0]?.props.message).toBe(
      i18n.t('spendAlerts.saved')
    );
    expect(byType(renderer, 'Button')).toHaveLength(1);

    // A draft edit clears it again, so the message never outlives its values.
    toggle(switchByLabel(renderer, i18n.t('spendAlerts.enable')), true);
    expect(byType(renderer, 'AccessibleStatus')[0]?.props.message).toBeNull();
  });
});

describe('SpendAlertsScreen master switch over an invalid hidden field', () => {
  it('lets Save pass when the switch hides an invalid limit, keeping the stored value', async () => {
    const { renderer } = await mountLoaded();

    // A blank, enabled limit disables Save while its card is on screen.
    type(renderer, LIMIT, '');
    expect(buttonByVariant(renderer).props.disabled).toBe(true);

    toggle(switchByLabel(renderer, i18n.t('spendAlerts.enable')), false);

    // The rule cards are gone, so no hidden field can gate Save any more.
    expect(byType(renderer, 'FormField')).toHaveLength(0);
    expect(buttonByVariant(renderer).props.disabled).toBe(false);

    press(buttonByVariant(renderer));

    await waitFor(() => saveMutationFn.mock.calls.length === 1);
    const input = saveMutationFn.mock.calls[0]?.[0] as {
      enabled: boolean;
      rules: { kind: string; threshold?: number; multiplierBasisPoints?: number }[];
    };
    expect(input.enabled).toBe(false);
    // The unusable hidden limit falls back to the last saved value, so turning
    // the feature off does not clobber the configured threshold.
    expect(input.rules.find(rule => rule.kind === 'threshold')?.threshold).toBe(25);
    expect(input.rules.find(rule => rule.kind === 'anomaly')?.multiplierBasisPoints).toBe(200);
  });
});

describe('SpendAlertsScreen push agreement', () => {
  it('saves the rule and the caller category when a push channel is turned on', async () => {
    const { renderer } = await mountLoaded();

    // [0] threshold push, [1] anomaly push
    toggle(channelSwitches(renderer, i18n.t('notifications.push'))[0], true);

    await waitFor(() => saveMutationFn.mock.calls.length === 1);
    const input = saveMutationFn.mock.calls[0]?.[0] as {
      rules: { kind: string; pushEnabled: boolean }[];
    };
    expect(input.rules).toContainEqual(
      expect.objectContaining({ kind: 'threshold', pushEnabled: true })
    );
    expect(input.rules).toContainEqual(
      expect.objectContaining({ kind: 'anomaly', pushEnabled: false })
    );
  });

  it('points the push row at Notifications when the category is off', async () => {
    const { renderer } = await mountLoaded({ pushCategoryEnabled: false });

    expect(texts(renderer)).toContain(i18n.t('spendAlerts.pushOffByCategory'));
    expect(channelSwitches(renderer, i18n.t('notifications.push'))).toHaveLength(0);
    expect(channelSwitches(renderer, i18n.t('common.email'))).toHaveLength(2);

    press(byType(renderer, 'Pressable')[0]);

    expect(router.push).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)/notifications');
  });

  it('points the push row at Notifications when the viewer has no device', async () => {
    const { renderer } = await mountLoaded({ pushChannelBlocked: true });

    expect(channelSwitches(renderer, i18n.t('notifications.push'))).toHaveLength(0);
    expect(byType(renderer, 'Pressable')).toHaveLength(2);
  });
});
