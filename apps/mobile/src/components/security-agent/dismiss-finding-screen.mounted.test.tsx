/* eslint-disable max-lines -- the CTA terminal-state and draft-on-type suites share one screen harness. */

// Dismiss-screen terminal-state contract: a persistence failure (the ledger
// could not record the outcome, so a same-key retry guarantee does not hold)
// and a missing-configuration rejection are non-retryable — the form must show
// its state-specific copy and disable the dismissal CTA. Retryable failures
// (in-progress, ambiguous, transport) keep the CTA so the user can retry
// under the same hoisted key.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as OrganizationsModule from '@kilocode/app-shared/organizations';

import { ScrollView } from 'react-native';
import { i18n } from '@/i18n';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { type SecurityFinding } from '@/lib/security-agent';
import { mapSecurityDismissOperationError } from '@/lib/security-agent-ledger';
import { ORGANIZATION_TRIAL_EXPIRED_MESSAGE } from '@/lib/server-error-copy';
import { TRIAL_ENDED_BILLING_COPY_KEY, TRIAL_ENDED_COPY_KEY } from '@/lib/trial-refusal-copy';
import { SettingsRecoveryStatus } from './settings-recovery-status';
import { DismissFindingScreen } from './dismiss-finding-screen';

// The security mutation hooks hoist an operation key through
// `@/lib/operation-key`, whose expo-crypto root import loads a native binding
// this node project does not have.
vi.mock('expo-crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000000' }));

const PERSISTENCE_FAILED_MESSAGE = vi.hoisted(
  () => 'We could not record this action. Please try again later.'
);
const IN_PROGRESS_COPY = vi.hoisted(
  () => 'This dismissal is already in progress. Please try again.'
);
const CONFIGURATION_ERROR_MESSAGE = vi.hoisted(() => 'Security service is not configured');
const CONFIGURATION_COPY = vi.hoisted(
  () => 'Security service is not configured. Resubmitting cannot succeed until this is fixed.'
);
const SERVICE_UNAVAILABLE_MESSAGE = vi.hoisted(() => 'Security service is unavailable');
const SERVICE_UNAVAILABLE_COPY = vi.hoisted(
  () => 'The security service is unavailable. Try again.'
);

// The two sentences the trial refusal has, one per reader, and the step the
// billing one offers.
const TRIAL_MEMBER_COPY = i18n.t(TRIAL_ENDED_COPY_KEY);
const TRIAL_BILLING_COPY = i18n.t(TRIAL_ENDED_BILLING_COPY_KEY);
const BILLING_ACTION_LABEL = i18n.t('organization.hub.manageBilling');

/** The lapsed-trial refusal as the organization gate sends it. */
function trialRefusal(): Error {
  return Object.assign(new Error(ORGANIZATION_TRIAL_EXPIRED_MESSAGE), {
    data: { code: 'FORBIDDEN' },
  });
}

const routerBack = vi.hoisted(() => vi.fn());
type MockedFinding = Pick<
  SecurityFinding,
  'status' | 'title' | 'repo_full_name' | 'package_name' | 'package_ecosystem'
>;
const dismiss = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  isError: false,
  error: null as Error | null,
}));
const capability = vi.hoisted(() => ({
  canManage: true,
  status: 'allowed' as 'allowed' | 'denied' | 'error' | 'loading',
  isLoading: false,
  isFetching: false,
  isError: false,
  isPending: false,
  fetchStatus: 'idle' as 'fetching' | 'paused' | 'idle',
  refetch: vi.fn(),
}));
const finding = vi.hoisted(() => ({
  isLoading: false,
  isFetching: false,
  isError: false,
  isPending: false,
  fetchStatus: 'idle' as 'fetching' | 'paused' | 'idle',
  error: null as unknown,
  data: undefined as MockedFinding | undefined,
  refetch: vi.fn(),
}));
const queryError = vi.hoisted(() => ({
  props: null as
    | { variant?: string; message?: string; onRetry?: () => void; placement?: string }
    | null,
}));
const pillGroup = vi.hoisted(() => ({
  onChange: (() => undefined) as (value: string) => void,
}));
const dismissDraft = vi.hoisted(() => ({
  draft: null as unknown,
  hydrated: true,
  persist: vi.fn(),
  clear: vi.fn(),
}));

vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  ActivityIndicator: 'ActivityIndicator',
  // The refusal step is a Pressable, and the shared status reads the platform
  // for its live region.
  Pressable: 'Pressable',
  Platform: { OS: 'android' },
}));
vi.mock('@/components/ui/icons', () => ({ ShieldOff: 'ShieldOff' }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: routerBack }),
}));
// The refusal hooks read the reader's role through the organization query
// chain; this harness has no organization provider and the chain pulls the Expo
// runtime it cannot load, so the boundary is stubbed and the real money-role
// rule decides from the role a case sets.
const trialRole = vi.hoisted(() => ({ role: undefined as string | undefined }));
vi.mock('@/lib/hooks/use-organization-queries', async () => {
  const { canManageOrganizationBilling } = await vi.importActual<typeof OrganizationsModule>(
    '@kilocode/app-shared/organizations'
  );
  return {
    isMoneyRole: canManageOrganizationBilling,
    useOrgBoundary: () => ({ role: trialRole.role }),
  };
});
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useMutedDisabledInk: () => '#fff',
  useThemeColors: () => ({ mutedForeground: '#000', primaryForeground: '#fff' }),
}));
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentCapability: () => capability,
}));
vi.mock('@/lib/hooks/use-security-findings', () => ({
  useSecurityFinding: () => finding,
  useDismissSecurityFinding: () => dismiss,
}));
vi.mock('@/lib/hooks/use-security-dismiss-draft', () => ({
  useSecurityDismissDraft: () => dismissDraft,
  securityDismissFailureCopy: (draft: { lastError: string }) => draft.lastError,
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({
  QueryError: (props: {
    variant?: string;
    message?: string;
    onRetry?: () => void;
    placement?: string;
  }) => {
    queryError.props = props;
    return 'QueryError';
  },
}));
vi.mock('@/components/security-agent/settings-recovery-status', () => ({
  SettingsRecoveryStatus: 'SettingsRecoveryStatus',
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: () => null }));
vi.mock('@/components/security-agent/settings-pill-group', () => ({
  PillGroup: (props: { onChange: (value: string) => void }) => {
    pillGroup.onChange = props.onChange;
    return null;
  },
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

type R = TestRenderer.ReactTestRenderer;
type I = TestRenderer.ReactTestInstance;

// The identity the sheet must name: one title, one repository, one package, so
// a user can tell this dismissal from the next.
const FINDING_IDENTITY = {
  title: 'ReDoS in payments SDK',
  repo_full_name: 'acme/payments-sdk',
  package_name: 'payments-sdk',
  package_ecosystem: 'npm',
} as const;

function renderScreen(): R {
  const ref: { current: R | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(DismissFindingScreen, { scope: 'personal', findingId: 'finding-1' })
    );
  });
  const r = ref.current;
  if (!r) {
    throw new Error('renderer was not created');
  }
  return r;
}

function selectReason(): void {
  act(() => {
    pillGroup.onChange('not_used');
  });
}

function findDismissButton(root: I): I {
  const nodes = root.findAll(n => typeof n.type === 'string' && (n.type as string) === 'Button');
  if (nodes.length !== 1) {
    throw new Error(`expected 1 dismissal Button, got ${nodes.length}`);
  }
  const n = nodes[0];
  if (!n) {
    throw new Error('dismissal Button not found');
  }
  return n;
}

function buttonDisabled(root: I): boolean | undefined {
  return findDismissButton(root).props.disabled as boolean | undefined;
}

function renderedTexts(root: I): string[] {
  return root
    .findAll(n => typeof n.type === 'string' && (n.type as string) === 'Text')
    .map(n => {
      const children: unknown = n.props.children;
      const parts = Array.isArray(children) ? (children as unknown[]) : [children];
      return parts.every(part => typeof part === 'string') ? (parts as string[]).join('') : null;
    })
    .filter((text): text is string => text !== null);
}

function findCommentInput(root: I): I {
  const nodes = root.findAll(n => typeof n.type === 'string' && (n.type as string) === 'TextInput');
  const n = nodes[0];
  if (!n) {
    throw new Error('comment TextInput not found');
  }
  return n;
}

/** The billing step a refusal renders under the sentence that names it. */
function billingSteps(root: I): I[] {
  return root.findAll(
    n =>
      typeof n.type === 'string' &&
      (n.type as string) === 'Pressable' &&
      n.props.accessibilityLabel === BILLING_ACTION_LABEL
  );
}

describe('DismissFindingScreen dismissal CTA states', () => {
  beforeEach(() => {
    trialRole.role = undefined;
    dismiss.mutate.mockClear();
    dismiss.isPending = false;
    dismiss.isError = false;
    dismiss.error = null;
    capability.canManage = true;
    capability.status = 'allowed';
    capability.isLoading = false;
    capability.isFetching = false;
    capability.isError = false;
    capability.isPending = false;
    capability.fetchStatus = 'idle';
    capability.refetch.mockReset();
    finding.isLoading = false;
    finding.isFetching = false;
    finding.isError = false;
    finding.isPending = false;
    finding.fetchStatus = 'idle';
    finding.error = null;
    finding.data = { status: 'open', ...FINDING_IDENTITY };
    finding.refetch.mockReset();
    dismissDraft.draft = null;
    dismissDraft.hydrated = true;
    dismissDraft.persist.mockClear();
    dismissDraft.clear.mockClear();
  });

  it('names the finding it dismisses above the reason group', () => {
    const tree = renderScreen();
    const texts = renderedTexts(tree.root);
    expect(texts).toContain(FINDING_IDENTITY.title);
    expect(texts).toContain(FINDING_IDENTITY.repo_full_name);
    expect(texts).toContain(
      `${FINDING_IDENTITY.package_name} (${FINDING_IDENTITY.package_ecosystem})`
    );
  });

  it.each(['finding', 'permissions'] as const)(
    'keeps the draft mounted and retries a cached %s failure without submitting',
    source => {
      const query = source === 'finding' ? finding : capability;
      const otherQuery = source === 'finding' ? capability : finding;
      const tree = renderScreen();
      selectReason();
      const input = findCommentInput(tree.root);
      act(() => {
        (input.props.onChangeText as (value: string) => void)('Keep this comment');
      });
      const update = () => {
        tree.update(
          createElement(DismissFindingScreen, { scope: 'personal', findingId: 'finding-1' })
        );
      };
      query.isError = true;
      finding.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
      act(update);
      const scroll = tree.root.findByType(ScrollView);
      const retry = scroll.findByType(SettingsRecoveryStatus);
      expect(tree.root.findAllByType(ScrollView)).toHaveLength(1);
      expect(tree.root.findAllByType(QueryError)).toHaveLength(0);
      expect(tree.root.findAllByType(EmptyState)).toHaveLength(0);
      act(retry.props.onRetry as () => void);
      expect(query.refetch).toHaveBeenCalledOnce();
      expect(otherQuery.refetch).not.toHaveBeenCalled();
      expect(dismiss.mutate).not.toHaveBeenCalled();
      query.isFetching = true;
      act(update);
      expect(retry.props.isRetrying).toBe(true);
      expect(findCommentInput(tree.root)).toBe(input);
      query.isFetching = false;
      query.isError = false;
      act(update);
      expect(tree.root.findByType(ScrollView)).toBe(scroll);
      expect(findCommentInput(tree.root)).toBe(input);
      expect(tree.root.findAllByType(SettingsRecoveryStatus)).toHaveLength(0);
      expect(buttonDisabled(tree.root)).toBe(false);
      act(findDismissButton(tree.root).props.onPress as () => void);
      expect(dismiss.mutate).toHaveBeenCalledWith(
        { findingId: 'finding-1', reason: 'not_used', comment: 'Keep this comment' },
        expect.any(Object)
      );
    }
  );

  it.each(['finding', 'permissions'] as const)(
    'keeps an uncached %s failure outside the form',
    source => {
      const query = source === 'finding' ? finding : capability;
      query.isError = true;
      if (source === 'finding') {
        finding.data = undefined;
      } else {
        capability.status = 'error';
      }
      const tree = renderScreen();
      expect(tree.root.findAllByType(ScrollView)).toHaveLength(0);
      expect(tree.root.findAllByType(SettingsRecoveryStatus)).toHaveLength(0);
      const error = tree.root.findByType(QueryError);
      expect(error.props.placement).not.toBe('top');
      act(error.props.onRetry as () => void);
      expect(query.refetch).toHaveBeenCalledOnce();
    }
  );

  it.each(['finding', 'permissions'] as const)(
    'names the connection and offers Retry for a paused %s read',
    source => {
      const query = source === 'finding' ? finding : capability;
      const otherQuery = source === 'finding' ? capability : finding;
      finding.data = undefined;
      query.isPending = true;
      query.fetchStatus = 'paused';
      const tree = renderScreen();

      expect(tree.root.findAllByType(ScrollView)).toHaveLength(0);
      const error = tree.root.findByType(QueryError);
      expect(error.props.variant).toBe('offline');
      expect(error.props.message).toBe(
        source === 'finding'
          ? i18n.t('securityAgent.dismiss.couldNotLoad')
          : i18n.t('securityAgent.dismiss.couldNotCheckPermissions')
      );
      act(error.props.onRetry as () => void);
      expect(query.refetch).toHaveBeenCalledOnce();
      expect(otherQuery.refetch).not.toHaveBeenCalled();
    }
  );

  it('keeps the skeleton for a first finding read still in flight', () => {
    finding.data = undefined;
    finding.isLoading = true;
    finding.fetchStatus = 'fetching';
    const tree = renderScreen();

    expect(tree.root.findAllByType(QueryError)).toHaveLength(0);
  });

  it.each([
    ['denied', 'open'],
    ['allowed', 'fixed'],
    ['allowed', 'dismissed'],
  ] as const)(
    'keeps %s permissions and a %s finding blocked after refetch failures',
    (status, findingStatus) => {
      capability.status = status;
      capability.canManage = status === 'allowed';
      capability.isError = true;
      finding.data = { status: findingStatus, ...FINDING_IDENTITY };
      finding.isError = true;
      finding.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
      const tree = renderScreen();
      expect(tree.root.findAllByType(ScrollView)).toHaveLength(0);
      expect(tree.root.findAllByType(EmptyState)).toHaveLength(1);
      expect(tree.root.findAllByType(SettingsRecoveryStatus)).toHaveLength(0);
      expect(tree.root.findAllByType(QueryError)).toHaveLength(0);
    }
  );

  it.each(['NOT_FOUND', 'FORBIDDEN'])('keeps the full-body %s state outside the form', code => {
    finding.isError = true;
    finding.error = { data: { code } };
    const tree = renderScreen();
    expect(tree.root.findAllByType(ScrollView)).toHaveLength(0);
    const empty = tree.root.findAllByType(EmptyState);
    expect(empty).toHaveLength(1);
    expect(empty[0]?.props.placement).not.toBe('top');
  });

  it('keeps the dismissal CTA enabled once a reason is chosen', () => {
    const root = renderScreen();
    selectReason();

    expect(buttonDisabled(root.root)).toBe(false);
  });

  it('keeps the dismissal CTA enabled after a retryable failure and shows its copy', () => {
    dismiss.isError = true;
    dismiss.error = mapSecurityDismissOperationError(new Error('operation_in_progress'));
    const root = renderScreen();
    selectReason();

    expect(buttonDisabled(root.root)).toBe(false);
    expect(renderedTexts(root.root)).toContain(IN_PROGRESS_COPY);
  });

  it('keeps the dismissal CTA live for a ledger persistence failure, whose copy invites the retry', () => {
    dismiss.isError = true;
    dismiss.error = mapSecurityDismissOperationError(new Error(PERSISTENCE_FAILED_MESSAGE));
    const root = renderScreen();
    selectReason();

    // The key was rotated, so a resubmit is a fresh intent; leaving the CTA
    // down would give the reader "try again later" with no way to try.
    expect(buttonDisabled(root.root)).toBe(false);
    expect(renderedTexts(root.root)).toContain(PERSISTENCE_FAILED_MESSAGE);
  });

  it('keeps the CTA live when a stored draft predates the retry rule', () => {
    dismissDraft.draft = {
      reason: 'not_used',
      comment: '',
      lastError: PERSISTENCE_FAILED_MESSAGE,
      lastErrorKey: null,
      retryable: false,
    };

    const root = renderScreen();
    selectReason();

    expect(buttonDisabled(root.root)).toBe(false);
    expect(renderedTexts(root.root)).toContain(PERSISTENCE_FAILED_MESSAGE);
  });

  it('disables the dismissal CTA and shows configuration-specific copy after a missing-configuration error', () => {
    dismiss.isError = true;
    dismiss.error = mapSecurityDismissOperationError(new Error(CONFIGURATION_ERROR_MESSAGE));
    const root = renderScreen();
    selectReason();

    expect(buttonDisabled(root.root)).toBe(true);
    expect(renderedTexts(root.root)).toContain(CONFIGURATION_COPY);
    // The raw server message is replaced by the state-specific copy.
    expect(renderedTexts(root.root)).not.toContain(CONFIGURATION_ERROR_MESSAGE);
  });

  it('keeps the dismissal CTA enabled after an unreachable service and shows retry copy', () => {
    dismiss.isError = true;
    dismiss.error = mapSecurityDismissOperationError(new Error(SERVICE_UNAVAILABLE_MESSAGE));
    const root = renderScreen();
    selectReason();

    expect(buttonDisabled(root.root)).toBe(false);
    expect(renderedTexts(root.root)).toContain(SERVICE_UNAVAILABLE_COPY);
    // The old ambiguous sentence must not be what the reader is told.
    expect(renderedTexts(root.root)).not.toContain(
      "Couldn't confirm — check the security review before retrying."
    );
  });

  it('gives a billing role the trial sentence and the step that ends it', () => {
    trialRole.role = 'owner';
    dismiss.isError = true;
    dismiss.error = mapSecurityDismissOperationError(trialRefusal(), true);
    const root = renderScreen();
    selectReason();

    // The plan is the fix, so the CTA stays down while the step out is offered.
    expect(buttonDisabled(root.root)).toBe(true);
    expect(renderedTexts(root.root)).toContain(TRIAL_BILLING_COPY);
    expect(renderedTexts(root.root)).not.toContain(TRIAL_MEMBER_COPY);
    expect(billingSteps(root.root)).toHaveLength(1);
  });

  it('keeps every other role on the owner-naming sentence, with no step', () => {
    trialRole.role = 'member';
    dismiss.isError = true;
    dismiss.error = mapSecurityDismissOperationError(trialRefusal());
    const root = renderScreen();
    selectReason();

    expect(buttonDisabled(root.root)).toBe(true);
    expect(renderedTexts(root.root)).toContain(TRIAL_MEMBER_COPY);
    expect(billingSteps(root.root)).toHaveLength(0);
  });

  it('a refusal mapped before the role settled re-reads as the billing sentence once the reader can change the plan', () => {
    trialRole.role = 'owner';
    dismiss.isError = true;
    // Mapped while the membership list was still unresolved, so the sentence
    // baked on the error is the member-worded one.
    dismiss.error = mapSecurityDismissOperationError(trialRefusal(), false);
    const root = renderScreen();
    selectReason();

    expect(buttonDisabled(root.root)).toBe(true);
    expect(renderedTexts(root.root)).toContain(TRIAL_BILLING_COPY);
    expect(renderedTexts(root.root)).not.toContain(TRIAL_MEMBER_COPY);
    expect(billingSteps(root.root)).toHaveLength(1);
  });

  it('a refusal mapped before the role settled re-reads as the owner-naming sentence once the reader loses the plan', () => {
    trialRole.role = 'member';
    dismiss.isError = true;
    // Mapped while the membership list still read as a billing role.
    dismiss.error = mapSecurityDismissOperationError(trialRefusal(), true);
    const root = renderScreen();
    selectReason();

    expect(buttonDisabled(root.root)).toBe(true);
    expect(renderedTexts(root.root)).toContain(TRIAL_MEMBER_COPY);
    expect(billingSteps(root.root)).toHaveLength(0);
  });

  it('disables the dismissal CTA while the dismissal is pending', () => {
    dismiss.isPending = true;
    const root = renderScreen();
    selectReason();

    expect(buttonDisabled(root.root)).toBe(true);
  });

  it('submits the dismissal and pops the screen only on success', () => {
    const root = renderScreen();
    selectReason();

    act(() => {
      (findDismissButton(root.root).props.onPress as () => void)();
    });

    expect(dismiss.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ findingId: 'finding-1', reason: 'not_used' }),
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) })
    );
  });

  it('records the intent as a draft before submitting', () => {
    const root = renderScreen();
    selectReason();

    act(() => {
      (findDismissButton(root.root).props.onPress as () => void)();
    });

    expect(dismissDraft.persist).toHaveBeenCalledWith({
      reason: 'not_used',
      comment: '',
      lastError: null,
      lastErrorKey: null,
      retryable: null,
    });
  });

  it('clears the draft and pops on authoritative accept', () => {
    const root = renderScreen();
    selectReason();

    act(() => {
      (findDismissButton(root.root).props.onPress as () => void)();
    });

    const options = dismiss.mutate.mock.calls[0]?.[1] as {
      onSuccess?: () => void;
    };
    act(() => {
      options.onSuccess?.();
    });

    expect(dismissDraft.clear).toHaveBeenCalledTimes(1);
    expect(routerBack).toHaveBeenCalledTimes(1);
  });

  it('persists lastError and retryable on a retryable failure', () => {
    const root = renderScreen();
    selectReason();

    act(() => {
      (findDismissButton(root.root).props.onPress as () => void)();
    });

    const options = dismiss.mutate.mock.calls[0]?.[1] as {
      onError?: (error: Error) => void;
    };
    act(() => {
      options.onError?.(mapSecurityDismissOperationError(new Error('operation_in_progress')));
    });

    expect(dismissDraft.persist).toHaveBeenLastCalledWith({
      reason: 'not_used',
      comment: '',
      lastError: IN_PROGRESS_COPY,
      lastErrorKey: 'securityAgent.mutations.dismissalInProgress',
      retryable: true,
    });
  });

  it('persists retry copy and a retryable draft when the Worker was unreachable', () => {
    const root = renderScreen();
    selectReason();

    act(() => {
      (findDismissButton(root.root).props.onPress as () => void)();
    });

    const options = dismiss.mutate.mock.calls[0]?.[1] as {
      onError?: (error: Error) => void;
    };
    act(() => {
      options.onError?.(mapSecurityDismissOperationError(new Error(SERVICE_UNAVAILABLE_MESSAGE)));
    });

    expect(dismissDraft.persist).toHaveBeenLastCalledWith({
      reason: 'not_used',
      comment: '',
      lastError: SERVICE_UNAVAILABLE_COPY,
      lastErrorKey: 'securityAgent.mutations.serviceUnavailable',
      retryable: true,
    });
  });

  it('persists the configuration copy and non-retryable on a missing-configuration failure', () => {
    const root = renderScreen();
    selectReason();

    act(() => {
      (findDismissButton(root.root).props.onPress as () => void)();
    });

    const options = dismiss.mutate.mock.calls[0]?.[1] as {
      onError?: (error: Error) => void;
    };
    act(() => {
      options.onError?.(mapSecurityDismissOperationError(new Error(CONFIGURATION_ERROR_MESSAGE)));
    });

    expect(dismissDraft.persist).toHaveBeenLastCalledWith({
      reason: 'not_used',
      comment: '',
      lastError: CONFIGURATION_COPY,
      lastErrorKey: 'securityAgent.mutations.serviceNotConfiguredResubmit',
      retryable: false,
    });
  });

  it('reopening after a terminal rejection shows the stored copy and keeps the CTA down', () => {
    // The rejection happened before a command id existed, so only the durable
    // draft records it; the reopened sheet has no live mutation error.
    dismissDraft.draft = {
      reason: 'not_used',
      comment: '',
      lastError: CONFIGURATION_COPY,
      lastErrorKey: null,
      retryable: false,
    };

    const root = renderScreen();

    expect(renderedTexts(root.root)).toContain(CONFIGURATION_COPY);
    expect(buttonDisabled(root.root)).toBe(true);

    // Choosing a reason is a new intent but not a new request: resubmitting the
    // same unrecoverable dismissal cannot succeed, so the CTA stays down.
    selectReason();
    expect(buttonDisabled(root.root)).toBe(true);
  });
});

describe('DismissFindingScreen draft persistence on type', () => {
  beforeEach(() => {
    dismissDraft.draft = null;
    dismissDraft.hydrated = true;
    dismissDraft.persist.mockClear();
  });

  it('persists the reason as a draft on selection', () => {
    renderScreen();
    selectReason();

    expect(dismissDraft.persist).toHaveBeenCalledWith({
      reason: 'not_used',
      comment: '',
      lastError: null,
      lastErrorKey: null,
      retryable: null,
    });
  });

  it('persists the comment as a draft on typing', () => {
    const root = renderScreen();

    act(() => {
      (findCommentInput(root.root).props.onChangeText as (value: string) => void)('some context');
    });

    expect(dismissDraft.persist).toHaveBeenCalledWith({
      reason: '',
      comment: 'some context',
      lastError: null,
      lastErrorKey: null,
      retryable: null,
    });
  });

  it('preserves the last failure when typing after a failure', () => {
    dismissDraft.draft = { reason: 'not_used', comment: '', lastError: 'boom', retryable: true };
    const root = renderScreen();

    act(() => {
      (findCommentInput(root.root).props.onChangeText as (value: string) => void)('edited');
    });

    expect(dismissDraft.persist).toHaveBeenCalledWith(
      expect.objectContaining({ comment: 'edited', lastError: 'boom', retryable: true })
    );
  });
});
