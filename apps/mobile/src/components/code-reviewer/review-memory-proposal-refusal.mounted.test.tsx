// The proposal sheet paints a refused save/approve on its own line. The
// organization subscription gate refuses those mutations too, so the line has
// to carry the reader's own copy and, for a role that can change the plan, the
// step that ends the state; every other role keeps the owner-naming sentence
// and no step.

import { createElement, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY } from '@kilocode/app-shared/code-review';

import { ReviewMemoryProposalSheet } from './review-memory-proposal-sheet';
import {
  billingStep,
  changeHandler,
  dismissHandler,
  doneHandler,
  hosts,
  pressHandler,
  sheet,
  statusMessage,
} from './review-memory-proposal-refusal.test-helpers';
import { collectText } from './review-memory-screen.test-helpers';
import { i18n } from '@/i18n';
import { type ReviewMemoryProposal } from '@/lib/review-memory-proposals';
import { ORGANIZATION_TRIAL_EXPIRED_MESSAGE } from '@/lib/server-error-copy';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  role: 'member' as string | undefined,
  /** The membership list has not answered yet: the role reads `undefined`. */
  listLoading: false,
  /** Close and navigation in the order they ran, so the dismissal is asserted. */
  events: [] as string[],
  /** Re-renders the mounted sheet, the frame the settled membership list causes. */
  settle: null as (() => void) | null,
  reject: vi.fn<(error?: unknown) => Promise<never>>(),
  save: vi.fn<(error?: unknown) => Promise<never>>(),
  push: vi.fn<(href: string) => void>(),
}));

vi.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
}));

vi.mock('expo-router', () => ({
  usePreventRemove: () => undefined,
  useRouter: () => ({ push: h.push }),
}));

vi.mock('@/components/agents/session-page-sheet', () => ({ SessionPageSheet: 'SessionPageSheet' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: vi.fn(), success: vi.fn() },
}));

// Role resolution reads the membership list; only that list is faked, so the
// real `useOrgBoundary` and `canManageOrganizationBilling` decide the role.
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: 'org_1', isLoaded: true }),
}));
vi.mock('@/lib/hooks/use-organizations-list', () => ({
  useOrganizationsList: () => ({
    data: h.listLoading ? undefined : [{ organizationId: 'org_1', role: h.role }],
    isLoading: h.listLoading,
    isError: false,
    isFetching: h.listLoading,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: { reviewMemory: { setEnabled: { mutate: vi.fn() } } },
  useTRPC: () => ({
    reviewMemory: {
      getDashboardSummary: { queryKey: () => ['reviewMemory.summary'] },
      listProposalsPage: { pathKey: () => ['reviewMemory.proposals'] },
      updateProposal: {
        mutationOptions: (options: object) => ({ mutationFn: h.save, ...options }),
      },
      rejectProposal: {
        mutationOptions: (options: object) => ({ mutationFn: h.reject, ...options }),
      },
      approveAndOpenChangeRequest: {
        mutationOptions: (options: object) => ({ mutationFn: h.reject, ...options }),
      },
    },
  }),
}));

function proposal(): ReviewMemoryProposal {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    owned_by_user_id: null,
    owned_by_organization_id: 'org_1',
    platform: 'github',
    repo_full_name: 'fixture/repository',
    status: 'open',
    title: 'Preserve error context',
    rationale: 'Errors should identify the failed operation.',
    proposed_markdown: '# Error guidance',
    evidence: [],
    positive_count: 1,
    negative_count: 2,
    neutral_count: 0,
    change_request_url: null,
    created_at: '2026-10-22T00:00:00Z',
    updated_at: '2026-10-22T00:00:00Z',
  };
}

/** A rejected mutation carrying one server sentence, as tRPC delivers it. */
function rejection(sentence: string) {
  return Object.assign(new Error(sentence), {
    data: { code: 'FORBIDDEN', message: sentence },
  });
}

/**
 * The sheet's parent in these tests. In the app the membership list settling
 * re-renders this subtree; `h.settle` is the handle a test uses to report that
 * frame.
 */
function SheetHarness({ onClose }: Readonly<{ onClose: () => void }>) {
  const [, setTurn] = useState(0);
  h.settle = () => {
    setTurn(turn => turn + 1);
  };
  return createElement(ReviewMemoryProposalSheet, {
    scope: 'org_1',
    proposal: proposal(),
    permission: { status: 'ready', canEdit: true, canManage: true },
    available: true,
    onClose,
  });
}

/** Mount the sheet with a close that records itself, so the order is asserted. */
function renderSheet() {
  return renderWithProviders(
    createElement(SheetHarness, {
      onClose: () => {
        h.events.push('close');
      },
    })
  );
}

async function pressButton(root: ReactTestInstance, label: string) {
  const button = hosts(root, 'Button').find(node => collectText(node).includes(label));
  if (!button) {
    throw new Error(`Missing ${label} button`);
  }
  await act(async () => {
    pressHandler(button)();
    // The mutation's own rejection settles in a microtask; keeping the flush
    // inside this act scope is what applies the refused state under it.
    await Promise.resolve();
  });
}

/** Fires the native dismissal report the presented sheet waits for. */
function reportDismissed(root: ReactTestInstance) {
  const onDismiss = dismissHandler(sheet(root));
  act(() => {
    onDismiss();
  });
}

/** A refused save: the draft carries an edit, so it is dirty when it fails. */
async function refuseSave() {
  const mounted = await renderSheet();
  const root = mounted.renderer.root;
  const field = hosts(root, 'FormField').find(
    node => node.props.label === i18n.t('codeReviewer.reviewMemory.proposalTitle')
  );
  if (!field) {
    throw new Error('Missing title field');
  }
  const onChangeText = changeHandler(field);
  act(() => {
    onChangeText('Updated title');
  });
  await pressButton(root, i18n.t('common.save'));
  await waitFor(() => statusMessage(mounted.renderer.root) !== null);
  return mounted;
}

/** A refused approve: the draft has no edit, so closing asks nothing. */
async function refuseApprove() {
  const mounted = await renderSheet();
  await pressButton(mounted.renderer.root, i18n.t('common.openPullRequest'));
  await waitFor(() => statusMessage(mounted.renderer.root) !== null);
  return mounted;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'member';
  h.listLoading = false;
  h.events = [];
  h.push.mockImplementation(() => {
    h.events.push('push');
  });
  h.save.mockImplementation(() => Promise.reject(rejection(ORGANIZATION_TRIAL_EXPIRED_MESSAGE)));
  h.reject.mockImplementation(() => Promise.reject(rejection(ORGANIZATION_TRIAL_EXPIRED_MESSAGE)));
});

describe('ReviewMemoryProposalSheet refusal', () => {
  it('offers a billing role the plan copy and the step to the billing screen', async () => {
    h.role = 'billing_manager';

    const { renderer } = await refuseSave();

    expect(statusMessage(renderer.root)).toBe(i18n.t('common.organizationTrialEndedBilling'));
    expect(billingStep(renderer.root)).toBeDefined();
  });

  it('keeps the owner-naming copy and adds no step for a member', async () => {
    const { renderer } = await refuseSave();

    expect(statusMessage(renderer.root)).toBe(i18n.t('common.organizationTrialEnded'));
    expect(billingStep(renderer.root)).toBeUndefined();
  });

  it('adds no step to a refusal that is not the trial gate, even for a billing role', async () => {
    h.role = 'owner';
    h.save.mockImplementation(() =>
      Promise.reject(rejection(REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY.change_request_in_progress))
    );

    const { renderer } = await refuseSave();

    expect(statusMessage(renderer.root)).toBe(
      i18n.t('codeReviewer.reviewMemory.changeRequestInProgress')
    );
    expect(billingStep(renderer.root)).toBeUndefined();
  });

  // The membership list answers after the refusal, which is the ordinary case on
  // a cold start. The sentence and the step are two readings of one role answer,
  // so they move together when it settles: the owner-naming sentence never stays
  // above a Manage billing step.
  it('derives the sentence and the step from the role that settles after the refusal', async () => {
    h.listLoading = true;
    h.role = 'billing_manager';

    const { renderer } = await refuseSave();

    // The refusal landed while the list was still loading, so the role it saw
    // was unknown and the copy names the person who can change the plan.
    expect(statusMessage(renderer.root)).toBe(i18n.t('common.organizationTrialEnded'));
    expect(billingStep(renderer.root)).toBeUndefined();

    // The list settles on a billing role: both readings change in one render.
    h.listLoading = false;
    act(() => {
      h.settle?.();
    });

    expect(statusMessage(renderer.root)).toBe(i18n.t('common.organizationTrialEndedBilling'));
    expect(billingStep(renderer.root)).toBeDefined();
  });

  // The sheet is presented over the route stack rather than being a route, so a
  // push while it is up lands behind it and the tap looks dead. The step closes
  // the sheet first and lets its dismissal report run the navigation.
  it('drops the parked navigation when the reader keeps editing', async () => {
    h.role = 'billing_manager';

    const { renderer } = await refuseSave();
    const root = renderer.root;
    const step = billingStep(root);
    if (!step) {
      throw new TypeError('Missing billing step');
    }

    // The dirty draft makes the step ask first, and the answer here is Keep
    // editing: nothing closes and nothing navigates.
    act(() => {
      pressHandler(step)();
    });
    expect(sheet(root).props.visible).toBe(true);
    expect(h.push).not.toHaveBeenCalled();

    // A later close of the cleaned draft must not carry the abandoned step.
    const field = hosts(root, 'FormField').find(
      node => node.props.label === i18n.t('codeReviewer.reviewMemory.proposalTitle')
    );
    if (!field) {
      throw new TypeError('Missing title field');
    }
    act(() => {
      changeHandler(field)('Preserve error context');
    });
    const header = hosts(root, 'SheetHeader')[0];
    if (!header) {
      throw new TypeError('Missing sheet header');
    }
    act(() => {
      doneHandler(header)();
    });
    expect(sheet(root).props.visible).toBe(false);

    reportDismissed(root);

    expect(h.events).toEqual(['close']);
    expect(h.push).not.toHaveBeenCalled();
  });

  it('closes the sheet before the billing route is pushed', async () => {
    h.role = 'billing_manager';

    const { renderer } = await refuseApprove();
    const step = billingStep(renderer.root);
    if (!step) {
      throw new Error('Missing billing step');
    }

    act(() => {
      pressHandler(step)();
    });

    expect(sheet(renderer.root).props.visible).toBe(false);
    expect(h.events).toEqual([]);

    reportDismissed(renderer.root);

    expect(h.events).toEqual(['close', 'push']);
    expect(h.push).toHaveBeenCalledWith(
      expect.stringContaining('/(app)/(tabs)/(3_profile)/organization/billing')
    );
  });
});
