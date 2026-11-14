// The proposal sheet paints a refused save/approve on its own line. The
// organization subscription gate refuses those mutations too, so the line has
// to carry the reader's own copy and, for a role that can change the plan, the
// step that ends the state; every other role keeps the owner-naming sentence
// and no step.

import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY } from '@kilocode/app-shared/code-review';

import { ReviewMemoryProposalSheet } from './review-memory-proposal-sheet';
import { collectText } from './review-memory-screen.test-helpers';
import { i18n } from '@/i18n';
import { type ReviewMemoryProposal } from '@/lib/review-memory-proposals';
import { ORGANIZATION_TRIAL_EXPIRED_MESSAGE } from '@/lib/server-error-copy';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  role: 'member' as string | undefined,
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
    data: [{ organizationId: 'org_1', role: h.role }],
    isLoading: false,
    isError: false,
    isFetching: false,
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

function hosts(root: ReactTestInstance, type: string) {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

function billingStep(root: ReactTestInstance) {
  return hosts(root, 'Pressable').find(
    node => node.props.accessibilityLabel === i18n.t('organization.hub.manageBilling')
  );
}

function statusMessage(root: ReactTestInstance): string | null {
  const status = hosts(root, 'AccessibleStatus')[0];
  if (!status) {
    throw new Error('Missing AccessibleStatus');
  }
  return (status.props as { message: string | null }).message;
}

async function saveEditedTitle() {
  const ui = await renderWithProviders(
    createElement(ReviewMemoryProposalSheet, {
      scope: 'org_1',
      proposal: proposal(),
      permission: { status: 'ready', canEdit: true, canManage: true },
      available: true,
      onClose: vi.fn<() => void>(),
    })
  );
  const field = hosts(ui.renderer.root, 'FormField').find(
    node => node.props.label === i18n.t('codeReviewer.reviewMemory.proposalTitle')
  );
  if (!field) {
    throw new Error('Missing title field');
  }
  act(() => {
    (field.props as { onChangeText: (text: string) => void }).onChangeText('Updated title');
  });
  const save = hosts(ui.renderer.root, 'Button').find(node =>
    collectText(node).includes(i18n.t('common.save'))
  );
  if (!save) {
    throw new Error('Missing Save button');
  }
  await act(() => {
    (save.props as { onPress: () => void }).onPress();
  });
  await waitFor(() => hosts(ui.renderer.root, 'AccessibleStatus').length > 0);
  return ui.renderer.root;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'member';
  h.save.mockImplementation(() => Promise.reject(rejection(ORGANIZATION_TRIAL_EXPIRED_MESSAGE)));
});

describe('ReviewMemoryProposalSheet refusal', () => {
  it('offers a billing role the plan copy and the step to the billing screen', async () => {
    h.role = 'billing_manager';

    const root = await saveEditedTitle();

    expect(statusMessage(root)).toBe(i18n.t('common.organizationTrialEndedBilling'));
    const step = billingStep(root);
    if (!step) {
      throw new Error('Missing billing step');
    }
    act(() => {
      (step.props as { onPress: () => void }).onPress();
    });
    expect(h.push).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)/organization/billing');
  });

  it('keeps the owner-naming copy and adds no step for a member', async () => {
    const root = await saveEditedTitle();

    expect(statusMessage(root)).toBe(i18n.t('common.organizationTrialEnded'));
    expect(billingStep(root)).toBeUndefined();
  });

  it('adds no step to a refusal that is not the trial gate, even for a billing role', async () => {
    h.role = 'owner';
    h.save.mockImplementation(() =>
      Promise.reject(rejection(REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY.change_request_in_progress))
    );

    const root = await saveEditedTitle();

    expect(statusMessage(root)).toBe(i18n.t('codeReviewer.reviewMemory.changeRequestInProgress'));
    expect(billingStep(root)).toBeUndefined();
  });
});
