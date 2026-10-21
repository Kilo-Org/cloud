// The low balance alert sheet's save contract: an empty threshold never looks
// filled, a rejected save names itself in localized copy on the field that
// caused it, and correcting the field drops the line while Save stays usable.

import { createElement } from 'react';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LowBalanceAlertSheet } from '@/components/organization/low-balance-alert-sheet';
import { i18n } from '@/i18n';
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
type SaveMutation = {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  mutate: (input: unknown) => unknown;
  reset: () => unknown;
};
const save = vi.hoisted(
  (): { value: SaveMutation } => ({
    // The hook's object is replaced per test; every field starts unset.
    value: { isPending: false, isError: false, error: null, mutate: vi.fn(), reset: vi.fn() },
  })
);

vi.mock('expo-router', () => ({ useRouter: () => ({ back: vi.fn() }) }));
vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(),
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('react-native', () => ({ ScrollView: 'ScrollView', Switch: 'Switch', View: 'View' }));
vi.mock('@/components/organization/organization-boundary', () => ({
  OrganizationBoundary: 'OrganizationBoundary',
}));
vi.mock('@/components/organization/permission-denied', () => ({
  PermissionDenied: 'PermissionDenied',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
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
  parseLocalizedNumber: (value: string) => {
    const parsed = Number(value.trim().replaceAll(',', ''));
    return Number.isFinite(parsed) ? parsed : null;
  },
}));

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
});

async function mountSheet() {
  const view = await renderWithProviders(createElement(LowBalanceAlertSheet));
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

    const button = renderer.root.find(node => String(node.type) === 'Button');
    expect(button.props.disabled).toBe(true);
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
    // button stays usable.
    const button = renderer.root.find(node => String(node.type) === 'Button');
    expect(button.props.disabled).toBe(false);
    unmount();
  });

  it('drops the rejected-save line when the recipient field is corrected', async () => {
    save.value = {
      ...save.value,
      isError: true,
      error: Object.assign(new Error(EMOJI_REJECTION), { data: { code: 'BAD_REQUEST' } }),
    };
    const { renderer, unmount } = await mountSheet();
    const recipients = fieldByLabel(
      renderer,
      i18n.t('organization.lowBalanceAlert.notifyEmailsLabel')
    );

    await act(() => {
      (recipients.props.onChangeText as (value: string) => void)('two@example.com');
    });

    expect(reset).toHaveBeenCalledOnce();
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
