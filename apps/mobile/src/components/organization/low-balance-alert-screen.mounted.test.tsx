// The low balance alert screen's save contract: the switch writes at once, the
// fields write on blur and on submit under one all-valid rule, and a rejected
// write keeps the draft, names itself in localized copy and offers Retry.

import { createElement } from 'react';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LowBalanceAlertScreen } from '@/components/organization/low-balance-alert-screen';
import { i18n } from '@/i18n';
import { formatPrefixedUsd } from '@/lib/format';
import { renderWithProviders } from '@/test/render-with-providers';

const boundary = vi.hoisted(() => ({
  organizationId: 'org-1' as string | null,
  role: 'owner',
  org: { organizationId: 'org-1' } as unknown,
  isResolving: false,
}));
const query = vi.hoisted(() => ({
  data: undefined as unknown,
  isPending: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
}));
type SaveCall = {
  input: {
    enabled: boolean;
    minimum_balance?: number;
    minimum_balance_alert_email?: string[];
  };
  options: { onSuccess?: () => void; onError?: (error: unknown) => void };
};
const saveMutate = vi.hoisted(() => vi.fn());
const calls = vi.hoisted((): { list: SaveCall[] } => ({ list: [] }));

vi.mock('expo-router', () => ({ useRouter: () => ({ back: vi.fn() }) }));
vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(),
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  useColorScheme: () => 'light',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Switch: 'Switch',
  View: 'View',
}));
vi.mock('@/components/organization/organization-boundary', () => ({
  OrganizationBoundary: 'OrganizationBoundary',
}));
vi.mock('@/components/organization/permission-denied', () => ({
  PermissionDenied: 'PermissionDenied',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
// The real clearance reads the tab bar and the keyboard, neither of which this
// suite models: the surface still renders its body as the ScrollView host.
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
// The switch row is the shared `PreferenceRow`: its trailing cell reaches the
// icon barrel, whose lucide modules this project cannot parse in the mounted
// environment, so the barrel is stubbed here the way every row suite does.
vi.mock('@/components/ui/icons', () => ({
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Check: 'Check',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  LogOut: 'LogOut',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    mutedForeground: '#6F6A61',
    primary: '#000000',
    primaryForeground: '#FFFFFF',
  }),
}));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgBoundary: () => boundary,
  useOrgWithMembers: () => query,
  isMoneyRole: (role: string) => role === 'owner' || role === 'billing_manager',
}));
vi.mock('@/lib/hooks/use-organization-mutations', () => ({
  useOrganizationMutations: () => ({
    updateMinimumBalanceAlert: { mutate: saveMutate, isPending: false },
  }),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ email: 'owner@example.com' }),
}));
vi.mock('@/lib/format', () => ({
  formatNumber: String,
  formatPrefixedUsd: String,
  normalizeLocalizedNumber: (value: string) => {
    const text = value.trim().replaceAll(',', '');
    return /^-?\d+(\.\d+)?$/.test(text) ? text : null;
  },
  parseLocalizedNumber: (value: string) => {
    const parsed = Number(value.trim().replaceAll(',', ''));
    return Number.isFinite(parsed) ? parsed : null;
  },
}));

const thresholdFieldOf = (renderer: ReactTestRenderer): ReactTestInstance =>
  fieldByLabel(renderer, i18n.t('organization.lowBalanceAlert.thresholdLabel'));

const emailsFieldOf = (renderer: ReactTestRenderer): ReactTestInstance =>
  fieldByLabel(renderer, i18n.t('organization.lowBalanceAlert.notifyEmailsLabel'));

const switchOf = (renderer: ReactTestRenderer): ReactTestInstance =>
  renderer.root.find(node => String(node.type) === 'Switch');

const retryButtonOf = (renderer: ReactTestRenderer): ReactTestInstance | undefined =>
  renderer.root
    .findAll(node => String(node.type) === 'Button')
    .find(node => node.props.accessibilityLabel === i18n.t('common.retry'));

/** The sentence the threshold field shows for an amount above the stored ceiling. */
const capSentence = () =>
  i18n.t('spendAlerts.thresholdMaxError', {
    max: formatPrefixedUsd(1_000_000_000, i18n.language, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }),
  });

const EMOJI_REJECTION =
  '[{"validation":"email","code":"invalid_format","path":["minimum_balance_alert_email"]}]';

beforeEach(() => {
  boundary.organizationId = 'org-1';
  boundary.org = { organizationId: 'org-1' };
  boundary.role = 'owner';
  boundary.isResolving = false;
  query.data = {
    settings: { minimum_balance: 25, minimum_balance_alert_email: ['one@example.com'] },
  };
  query.isPending = false;
  query.isError = false;
  query.isFetching = false;
  query.refetch.mockClear();
  calls.list = [];
  saveMutate.mockClear();
  saveMutate.mockImplementation((input: SaveCall['input'], options: SaveCall['options']) => {
    calls.list.push({ input, options });
  });
});

async function mountScreen() {
  return renderWithProviders(createElement(LowBalanceAlertScreen));
}

function fieldByLabel(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const field = renderer.root
    .findAll(node => String(node.type) === 'FormField')
    .find(node => node.props.label === label);
  if (!field) {
    throw new Error(`FormField for ${label} not found`);
  }
  return field;
}

function statusMessages(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => String(node.type) === 'AccessibleStatus')
    .map(node => node.props.message)
    .filter((message): message is string => typeof message === 'string');
}

describe('low balance alert screen', () => {
  it('renders the pushed screen header instead of a sheet header', async () => {
    const { renderer, unmount } = await mountScreen();
    expect(renderer.root.findAll(node => String(node.type) === 'ScreenHeader')).toHaveLength(1);
    expect(renderer.root.findAll(node => String(node.type) === 'SheetHeader')).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'Switch')).toHaveLength(1);
    unmount();
  });

  it('shows the required amount and stores nothing when the alert is switched on empty', async () => {
    query.data = { settings: {} };
    const { renderer, unmount } = await mountScreen();
    await act(() => {
      (switchOf(renderer).props.onValueChange as (value: boolean) => void)(true);
    });

    expect(saveMutate).not.toHaveBeenCalled();
    const threshold = thresholdFieldOf(renderer);
    // The placeholder must not read as a value the form already holds.
    expect(String(threshold.props.placeholder)).not.toMatch(/^[\d.,\s]+$/);
    expect(threshold.props.defaultValue).toBeUndefined();
    expect(threshold.props.error).toBe(i18n.t('organization.lowBalanceAlert.thresholdError'));
    // The prefilled signer address is valid, so only the amount names itself.
    expect(emailsFieldOf(renderer).props.error).toBeUndefined();
    unmount();
  });

  it('stores the whole draft when the alert is switched on with valid values', async () => {
    query.data = { settings: {} };
    const { renderer, unmount } = await mountScreen();
    await act(() => {
      (switchOf(renderer).props.onValueChange as (value: boolean) => void)(true);
    });
    expect(saveMutate).not.toHaveBeenCalled();

    await act(() => {
      (thresholdFieldOf(renderer).props.onChangeText as (value: string) => void)('25');
    });
    await act(() => {
      (thresholdFieldOf(renderer).props.onBlur as () => void)();
    });

    expect(calls.list).toHaveLength(1);
    expect(calls.list[0]?.input).toEqual({
      enabled: true,
      minimum_balance: 25,
      minimum_balance_alert_email: ['owner@example.com'],
    });
    unmount();
  });

  it('writes the switch off at once and hides the fields', async () => {
    const { renderer, unmount } = await mountScreen();
    expect(thresholdFieldOf(renderer)).toBeDefined();

    await act(() => {
      (switchOf(renderer).props.onValueChange as (value: boolean) => void)(false);
    });

    expect(calls.list).toHaveLength(1);
    expect(calls.list[0]?.input).toEqual({ enabled: false });
    expect(
      renderer.root.findAll(
        node =>
          String(node.type) === 'FormField' &&
          node.props.label === i18n.t('organization.lowBalanceAlert.thresholdLabel')
      )
    ).toHaveLength(0);
    unmount();
  });

  it('commits the recipients on the keyboard submit', async () => {
    const { renderer, unmount } = await mountScreen();
    await act(() => {
      (emailsFieldOf(renderer).props.onChangeText as (value: string) => void)(
        'two@example.com, three@example.com'
      );
    });
    expect(saveMutate).not.toHaveBeenCalled();

    await act(() => {
      (emailsFieldOf(renderer).props.onSubmitEditing as () => void)();
    });

    expect(calls.list[0]?.input).toEqual({
      enabled: true,
      minimum_balance: 25,
      minimum_balance_alert_email: ['two@example.com', 'three@example.com'],
    });
    unmount();
  });

  it('names both invalid fields and stores nothing when the draft cannot be committed', async () => {
    const { renderer, unmount } = await mountScreen();
    await act(() => {
      (thresholdFieldOf(renderer).props.onChangeText as (value: string) => void)('0');
    });
    await act(() => {
      (emailsFieldOf(renderer).props.onChangeText as (value: string) => void)('');
    });
    await act(() => {
      (emailsFieldOf(renderer).props.onBlur as () => void)();
    });

    expect(saveMutate).not.toHaveBeenCalled();
    expect(thresholdFieldOf(renderer).props.error).toBe(
      i18n.t('organization.lowBalanceAlert.thresholdError')
    );
    expect(emailsFieldOf(renderer).props.error).toBe(
      i18n.t('organization.lowBalanceAlert.emailsRequired')
    );
    unmount();
  });

  it('names an amount above the ceiling on the keystroke, then commits once corrected', async () => {
    const { renderer, unmount } = await mountScreen();
    const paste = '1'.repeat(300);
    await act(() => {
      (thresholdFieldOf(renderer).props.onChangeText as (value: string) => void)(paste);
    });

    expect(thresholdFieldOf(renderer).props.error).toBe(capSentence());
    expect(
      (thresholdFieldOf(renderer).props.validate as (value: string) => string | null)(paste)
    ).toBe(capSentence());

    await act(() => {
      (thresholdFieldOf(renderer).props.onChangeText as (value: string) => void)('250');
    });
    await act(() => {
      (thresholdFieldOf(renderer).props.onSubmitEditing as () => void)();
    });

    expect(thresholdFieldOf(renderer).props.error).toBeUndefined();
    expect(calls.list[0]?.input.minimum_balance).toBe(250);
    unmount();
  });

  it('names a stored amount above the ceiling before any interaction', async () => {
    query.data = {
      settings: {
        minimum_balance: 2_000_000_000,
        minimum_balance_alert_email: ['one@example.com'],
      },
    };
    const { renderer, unmount } = await mountScreen();
    expect(thresholdFieldOf(renderer).props.error).toBe(capSentence());
    // Nothing to commit at the mount: the seeded draft is the stored one, and
    // it is not written back until the person asks.
    expect(saveMutate).not.toHaveBeenCalled();
    unmount();
  });

  it('keeps the draft and offers Retry after a rejected write', async () => {
    const { renderer, unmount } = await mountScreen();
    await act(() => {
      (thresholdFieldOf(renderer).props.onChangeText as (value: string) => void)('250');
    });
    await act(() => {
      (thresholdFieldOf(renderer).props.onBlur as () => void)();
    });
    const first = calls.list[0];
    await act(() => {
      first?.options.onError?.(new Error('Failed to fetch'));
    });

    expect(statusMessages(renderer)).toContain(i18n.t('organization.lowBalanceAlert.saveError'));
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Failed to fetch');

    const retry = retryButtonOf(renderer);
    expect(retry).toBeDefined();
    await act(() => {
      (retry?.props.onPress as () => void)();
    });

    expect(calls.list).toHaveLength(2);
    expect(calls.list[1]?.input).toEqual(first?.input);
    unmount();
  });

  it('puts a schema rejection on the recipient field instead of the server message', async () => {
    const { renderer, unmount } = await mountScreen();
    await act(() => {
      (emailsFieldOf(renderer).props.onChangeText as (value: string) => void)('owner@example.com');
    });
    await act(() => {
      (emailsFieldOf(renderer).props.onBlur as () => void)();
    });
    const first = calls.list[0];
    await act(() => {
      first?.options.onError?.(
        Object.assign(new Error(EMOJI_REJECTION), { data: { code: 'BAD_REQUEST' } })
      );
    });

    expect(statusMessages(renderer)).toContain(
      i18n.t('organization.lowBalanceAlert.saveEmailsError')
    );
    expect(statusMessages(renderer)).not.toContain(
      i18n.t('organization.lowBalanceAlert.saveError')
    );
    expect(JSON.stringify(renderer.toJSON())).not.toContain('invalid_format');
    // The rejection keeps the draft and its Retry usable.
    expect(retryButtonOf(renderer)).toBeDefined();
    unmount();
  });

  it('does not confirm a draft that moved on while a write was in flight', async () => {
    const { renderer, unmount } = await mountScreen();
    await act(() => {
      (thresholdFieldOf(renderer).props.onChangeText as (value: string) => void)('30');
    });
    await act(() => {
      (thresholdFieldOf(renderer).props.onBlur as () => void)();
    });
    expect(calls.list).toHaveLength(1);

    // A newer draft asks to be written while the first request is still open:
    // it waits, and the first response must not confirm it.
    await act(() => {
      (thresholdFieldOf(renderer).props.onChangeText as (value: string) => void)('40');
    });
    await act(() => {
      (thresholdFieldOf(renderer).props.onSubmitEditing as () => void)();
    });
    expect(calls.list).toHaveLength(1);

    await act(() => {
      calls.list[0]?.options.onSuccess?.();
    });
    expect(statusMessages(renderer)).not.toContain(i18n.t('organizationGuardrails.statusSaved'));
    expect(calls.list).toHaveLength(2);
    expect(calls.list[1]?.input.minimum_balance).toBe(40);

    await act(() => {
      calls.list[1]?.options.onSuccess?.();
    });
    expect(statusMessages(renderer)).toContain(i18n.t('organizationGuardrails.statusSaved'));
    unmount();
  });

  it('keeps a missing organization on the boundary with a header', async () => {
    boundary.organizationId = null;
    boundary.org = null;
    const { renderer, unmount } = await mountScreen();
    const boundaryNode = renderer.root.find(node => String(node.type) === 'OrganizationBoundary');
    expect(boundaryNode.props.title).toBe(i18n.t('organization.lowBalanceAlert.title'));
    unmount();
  });

  it('keeps a failed read retryable outside the scroller', async () => {
    query.isError = true;
    query.data = undefined;
    const { renderer, unmount } = await mountScreen();
    expect(renderer.root.findAll(node => String(node.type) === 'ScrollView')).toHaveLength(0);
    const error = renderer.root.find(node => String(node.type) === 'QueryError');
    (error.props.onRetry as () => void)();
    expect(query.refetch).toHaveBeenCalledOnce();
    unmount();
  });

  it('keeps a refused role on the permission state', async () => {
    boundary.role = 'member';
    const { renderer, unmount } = await mountScreen();
    expect(renderer.root.findAll(node => String(node.type) === 'PermissionDenied')).toHaveLength(1);
    unmount();
  });
});
