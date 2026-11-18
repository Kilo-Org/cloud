// The module-mock harness for the low balance alert screen's mounted suites.
// This import MUST stay first in each suite: the helpers register the module
// mocks while they are evaluated.

import { createElement } from 'react';
import { type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { vi } from 'vitest';

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
export type SaveCall = {
  input: {
    enabled: boolean;
    minimum_balance?: number;
    minimum_balance_alert_email?: string[];
  };
  options: { onSuccess?: () => void; onError?: (error: unknown) => void };
};
const saveMutate = vi.hoisted(() => vi.fn());
const calls = vi.hoisted((): { list: SaveCall[] } => ({ list: [] }));

// `vi.hoisted` results cannot be exported at their declaration (vitest hoists
// them above the export), so they are exported after the declaration instead.
export { boundary, calls, query, saveMutate };

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

/** Return the mocked data layer to the values each test starts from. */
export function resetLowBalanceState(): void {
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
}

export function mountScreen() {
  return renderWithProviders(createElement(LowBalanceAlertScreen));
}

export function fieldByLabel(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const field = renderer.root
    .findAll(node => String(node.type) === 'FormField')
    .find(node => node.props.label === label);
  if (!field) {
    throw new Error(`FormField for ${label} not found`);
  }
  return field;
}

export const thresholdFieldOf = (renderer: ReactTestRenderer): ReactTestInstance =>
  fieldByLabel(renderer, i18n.t('organization.lowBalanceAlert.thresholdLabel'));

export const emailsFieldOf = (renderer: ReactTestRenderer): ReactTestInstance =>
  fieldByLabel(renderer, i18n.t('organization.lowBalanceAlert.notifyEmailsLabel'));

export const switchOf = (renderer: ReactTestRenderer): ReactTestInstance =>
  renderer.root.find(node => String(node.type) === 'Switch');

export const retryButtonOf = (renderer: ReactTestRenderer): ReactTestInstance | undefined =>
  renderer.root
    .findAll(node => String(node.type) === 'Button')
    .find(node => node.props.accessibilityLabel === i18n.t('common.retry'));

/** The sentence the threshold field shows for an amount above the stored ceiling. */
export const capSentence = () =>
  i18n.t('spendAlerts.thresholdMaxError', {
    max: formatPrefixedUsd(1_000_000_000, i18n.language, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }),
  });

export const EMOJI_REJECTION =
  '[{"validation":"email","code":"invalid_format","path":["minimum_balance_alert_email"]}]';

export function statusMessages(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => String(node.type) === 'AccessibleStatus')
    .map(node => node.props.message)
    .filter((message): message is string => typeof message === 'string');
}
