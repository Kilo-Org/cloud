// The low balance alert sheet's save contract: an empty threshold never looks
// filled, a rejected save names itself in localized copy on the field that
// caused it, and correcting the field drops the line while Save stays usable.

import { createElement, useEffect, useState } from 'react';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LowBalanceAlertSheet } from '@/components/organization/low-balance-alert-sheet';
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
const reset = vi.hoisted(() => vi.fn());
const saveMutate = vi.hoisted(() => vi.fn());
const bump = vi.hoisted((): { render: () => void } => ({ render: () => undefined }));
type SaveMutation = {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  mutate: (input: unknown) => unknown;
  reset: () => unknown;
};
const save = vi.hoisted((): { value: SaveMutation } => ({
  // The hook's object is replaced per test; every field starts unset.
  value: { isPending: false, isError: false, error: null, mutate: vi.fn(), reset: vi.fn() },
}));

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
vi.mock('@/components/tab-screen', () => ({ SheetScrollView: 'ScrollView' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/lib/navigation/pop-once', () => ({ usePopOnce: () => vi.fn() }));
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
  useOrganizationMutations: () => ({ updateMinimumBalanceAlert: save.value }),
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
/** The header's Done control commits the form, so it owns the unavailable state. */
const saveButtonOf = (renderer: ReactTestRenderer): ReactTestInstance =>
  renderer.root.find(node => String(node.type) === 'SheetHeader');

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
  reset.mockClear();
  saveMutate.mockClear();
  save.value = {
    isPending: false,
    isError: false,
    error: null,
    mutate: saveMutate,
    reset,
  };
  // The real hook's `reset` clears the mutation error, which re-renders the
  // sheet; the mock does the same so the discarded line is observable.
  reset.mockImplementation(() => {
    save.value = { ...save.value, isError: false, error: null };
    bump.render();
  });
});

/**
 * Re-renders the sheet when the mocked mutation state changes. The sheet's own
 * state is untouched, so the draft survives a rejected save.
 */
function Harness() {
  const [, setVersion] = useState(0);
  useEffect(() => {
    bump.render = () => {
      setVersion(version => version + 1);
    };
  }, []);
  return createElement(LowBalanceAlertSheet);
}

async function mountSheet() {
  const view = await renderWithProviders(createElement(Harness));
  return view;
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

describe('low balance alert sheet', () => {
  it('shows an unfilled threshold with a hint, and keeps Save disabled, after the alert is switched on', async () => {
    query.data = { settings: { minimum_balance_alert_email: ['one@example.com'] } };
    const { renderer, unmount } = await mountSheet();
    const toggle = renderer.root.find(node => String(node.type) === 'Switch');
    await act(() => {
      (toggle.props.onValueChange as (value: boolean) => void)(true);
    });

    const threshold = fieldByLabel(renderer, i18n.t('organization.lowBalanceAlert.thresholdLabel'));
    expect(threshold.props.placeholder).toBe(
      i18n.t('organization.lowBalanceAlert.thresholdPlaceholder')
    );
    // The placeholder must not read as a value the form already holds.
    expect(String(threshold.props.placeholder)).not.toMatch(/^[\d.,\s]+$/);
    expect(threshold.props.defaultValue).toBeUndefined();

    expect(saveButtonOf(renderer).props.doneDisabled).toBe(true);
    unmount();
  });

  it('puts a schema rejection on the recipient field instead of the server message', async () => {
    save.value = {
      ...save.value,
      isError: true,
      error: Object.assign(new Error(EMOJI_REJECTION), { data: { code: 'BAD_REQUEST' } }),
    };
    const { renderer, unmount } = await mountSheet();

    expect(statusMessages(renderer)).toContain(
      i18n.t('organization.lowBalanceAlert.saveEmailsError')
    );
    expect(statusMessages(renderer)).not.toContain(
      i18n.t('organization.lowBalanceAlert.saveError')
    );
    expect(JSON.stringify(renderer.toJSON())).not.toContain('invalid_format');

    // The rejection does not take Save away: the draft is intact and the
    // control stays usable.
    expect(saveButtonOf(renderer).props.doneDisabled).toBe(false);
    unmount();
  });

  it('drops the rejected-save line when the recipient field is corrected', async () => {
    save.value = {
      ...save.value,
      isError: true,
      error: Object.assign(new Error(EMOJI_REJECTION), { data: { code: 'BAD_REQUEST' } }),
    };
    const { renderer, unmount } = await mountSheet();
    expect(statusMessages(renderer)).toContain(
      i18n.t('organization.lowBalanceAlert.saveEmailsError')
    );
    const recipients = fieldByLabel(
      renderer,
      i18n.t('organization.lowBalanceAlert.notifyEmailsLabel')
    );

    await act(() => {
      (recipients.props.onChangeText as (value: string) => void)('two@example.com');
    });

    expect(reset).toHaveBeenCalledOnce();
    expect(statusMessages(renderer)).not.toContain(
      i18n.t('organization.lowBalanceAlert.saveEmailsError')
    );
    // Correcting the field leaves Save usable.
    expect(saveButtonOf(renderer).props.doneDisabled).toBe(false);
    unmount();
  });

  it('disables Save for a threshold too large to store, then re-enables it once corrected', async () => {
    const { renderer, unmount } = await mountSheet();
    const toggle = renderer.root.find(node => String(node.type) === 'Switch');
    await act(() => {
      (toggle.props.onValueChange as (value: boolean) => void)(true);
    });

    const threshold = thresholdFieldOf(renderer);
    const paste = '1'.repeat(300);
    await act(() => {
      (threshold.props.onChangeText as (value: string) => void)(paste);
    });

    expect(saveButtonOf(renderer).props.doneDisabled).toBe(true);
    expect(
      (thresholdFieldOf(renderer).props.validate as (value: string) => string | null)(paste)
    ).toBe(capSentence());

    await act(() => {
      (threshold.props.onChangeText as (value: string) => void)('250');
    });
    expect(saveButtonOf(renderer).props.doneDisabled).toBe(false);

    // Switching the alert off unmounts the field and switching it back on
    // remounts it with the draft still above the ceiling, so the field names
    // the cap again instead of leaving Save disabled with no reason.
    await act(() => {
      (threshold.props.onChangeText as (value: string) => void)('1000000001');
    });
    await act(() => {
      (toggle.props.onValueChange as (value: boolean) => void)(false);
    });
    await act(() => {
      (toggle.props.onValueChange as (value: boolean) => void)(true);
    });
    expect(thresholdFieldOf(renderer).props.error).toBe(capSentence());
    expect(saveButtonOf(renderer).props.doneDisabled).toBe(true);
    unmount();

    // A stored amount above the ceiling names itself at the mount, with no
    // interaction: the field shows the cap and Save stays disabled.
    query.data = {
      settings: {
        minimum_balance: 2_000_000_000,
        minimum_balance_alert_email: ['one@example.com'],
      },
    };
    const seeded = await mountSheet();
    expect(thresholdFieldOf(seeded.renderer).props.error).toBe(capSentence());
    expect(saveButtonOf(seeded.renderer).props.doneDisabled).toBe(true);

    const seededThreshold = thresholdFieldOf(seeded.renderer);
    await act(() => {
      (seededThreshold.props.onChangeText as (value: string) => void)('250');
    });
    expect(thresholdFieldOf(seeded.renderer).props.error).toBeUndefined();
    expect(saveButtonOf(seeded.renderer).props.doneDisabled).toBe(false);
    seeded.unmount();
  });

  it('names the ceiling on the keystroke that pastes an amount above it, before any blur', async () => {
    const { renderer, unmount } = await mountSheet();
    expect(thresholdFieldOf(renderer).props.error).toBeUndefined();

    await act(() => {
      (thresholdFieldOf(renderer).props.onChangeText as (value: string) => void)('1000000001');
    });

    expect(thresholdFieldOf(renderer).props.error).toBe(capSentence());
    expect(saveButtonOf(renderer).props.doneDisabled).toBe(true);

    await act(() => {
      (thresholdFieldOf(renderer).props.onChangeText as (value: string) => void)('250');
    });

    expect(thresholdFieldOf(renderer).props.error).toBeUndefined();
    expect(saveButtonOf(renderer).props.doneDisabled).toBe(false);
    unmount();
  });

  it('keeps a transport failure to the localized form line, never its raw text', async () => {
    save.value = { ...save.value, isError: true, error: new Error('Failed to fetch') };
    const { renderer, unmount } = await mountSheet();

    expect(statusMessages(renderer)).toContain(i18n.t('organization.lowBalanceAlert.saveError'));
    expect(statusMessages(renderer)).not.toContain(
      i18n.t('organization.lowBalanceAlert.saveEmailsError')
    );
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Failed to fetch');
    unmount();
  });
});
