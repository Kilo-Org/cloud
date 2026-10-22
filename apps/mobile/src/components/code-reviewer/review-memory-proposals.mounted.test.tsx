/* eslint-disable max-lines -- mounted interaction suite covers the proposal mutation and permission lifecycle */

import { QueryClientProvider } from '@tanstack/react-query';
import { createElement, Fragment, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ReviewMemoryScreen } from './review-memory-screen';
import { collectText } from './review-memory-screen.test-helpers';
import { i18n } from '@/i18n';
import { type PermissionState } from '@/lib/code-reviewer-status';
import { type ProposalDraft, type ReviewMemoryProposal } from '@/lib/review-memory-proposals';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

const h = vi.hoisted(() => {
  const permission: PermissionState = { status: 'ready', canEdit: true };
  return {
    rows: [] as ReviewMemoryProposal[],
    permission: permission as PermissionState,
    saveFailure: false,
    approveFailure: false,
    saveGate: null as Promise<undefined> | null,
    list: vi.fn(),
    summary: vi.fn(),
    save: vi.fn(),
    reject: vi.fn(),
    approve: vi.fn(),
    confirm: vi.fn(),
    permissionRetry: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    openUrl: vi.fn(),
  };
});

vi.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  Switch: 'Switch',
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    ListFooterComponent,
  }: {
    data: ReviewMemoryProposal[];
    renderItem: (info: { item: ReviewMemoryProposal }) => ReactElement;
    ListFooterComponent?: ReactElement;
  }) =>
    createElement(
      Fragment,
      null,
      ...data.map(item => createElement(Fragment, { key: item.id }, renderItem({ item }))),
      ListFooterComponent
    ),
}));
vi.mock('@/components/agents/session-page-sheet', () => ({ SessionPageSheet: 'SessionPageSheet' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({ Brain: 'Brain' }));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ useTabBarBottomPadding: () => 0 }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: h.confirm, dialog: null }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: 'gray' }),
}));
vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  useReviewerPermission: () => h.permission,
  useSetReviewMemoryEnabled: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: h.success, error: h.error },
}));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: h.openUrl }));
vi.mock('@/lib/trpc', () => ({
  trpcClient: {},
  useTRPC: () => ({
    reviewMemory: {
      getDashboardSummary: {
        queryKey: () => ['memory', 'summary'],
        queryOptions: () => ({ queryKey: ['memory', 'summary'], queryFn: h.summary }),
      },
      listProposalsPage: {
        pathKey: () => ['memory', 'proposals'],
        infiniteQueryOptions: (input: unknown, options: object) => ({
          queryKey: ['memory', 'proposals'],
          initialPageParam: undefined,
          queryFn: async () => {
            const result = await h.list(input);
            return result;
          },
          ...options,
        }),
      },
      updateProposal: {
        mutationOptions: (options: object) => ({ mutationFn: h.save, ...options }),
      },
      rejectProposal: {
        mutationOptions: (options: object) => ({ mutationFn: h.reject, ...options }),
      },
      approveAndOpenChangeRequest: {
        mutationOptions: (options: object) => ({ mutationFn: h.approve, ...options }),
      },
    },
  }),
}));

function proposal(status: ReviewMemoryProposal['status'] = 'open'): ReviewMemoryProposal {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    owned_by_user_id: 'fake-owner',
    owned_by_organization_id: null,
    platform: 'github',
    repo_full_name: 'fixture/repository',
    status,
    title: 'Preserve error context',
    rationale: 'Errors should identify the failed operation.',
    proposed_markdown: '# Error guidance\n\nKeep **context** and <raw> text.',
    evidence: [],
    positive_count: 1,
    negative_count: 2,
    neutral_count: 0,
    change_request_url: null,
    created_at: '2026-10-22T00:00:00Z',
    updated_at: '2026-10-22T00:00:00Z',
  };
}

function hosts(root: ReactTestInstance, type: string) {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}
function one(root: ReactTestInstance, type: string) {
  const node = hosts(root, type)[0];
  if (!node) {
    throw new Error(`Missing ${type}`);
  }
  return node;
}
function button(root: ReactTestInstance, key: string) {
  const label = i18n.t(key);
  const node = hosts(root, 'Button').find(candidate => collectText(candidate).includes(label));
  if (!node) {
    throw new Error(`Missing button ${label}`);
  }
  return node;
}
function press(node: ReactTestInstance) {
  const props = node.props as { disabled?: boolean; onPress: () => void };
  expect(props.disabled).not.toBe(true);
  act(() => {
    props.onPress();
  });
}
function change(root: ReactTestInstance, key: string, value: string) {
  const field = hosts(root, 'FormField').find(node => node.props.label === i18n.t(key));
  if (!field) {
    throw new Error(`Missing field ${key}`);
  }
  const props = field.props as { onChangeText: (text: string) => void };
  act(() => {
    props.onChangeText(value);
  });
}
function firstRow(root: ReactTestInstance) {
  const row = hosts(root, 'Pressable').find(node => node.props.accessibilityRole === 'button');
  if (!row) {
    throw new Error('Missing proposal row');
  }
  return row;
}
async function mountOpen() {
  const ui = await renderWithProviders(createElement(ReviewMemoryScreen, { scope: 'personal' }));
  await waitFor(() =>
    hosts(ui.renderer.root, 'Pressable').some(node => node.props.accessibilityRole === 'button')
  );
  press(firstRow(ui.renderer.root));
  return ui;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.rows = [proposal()];
  h.permission = { status: 'ready', canEdit: true };
  h.saveFailure = false;
  h.approveFailure = false;
  h.saveGate = null;
  h.summary.mockImplementation(async () => {
    await Promise.resolve();
    return {
      enabled: true,
      repositories: [],
      openProposalCount: h.rows.filter(
        row => row.status !== 'rejected' && row.status !== 'superseded'
      ).length,
    };
  });
  h.list.mockImplementation(
    async ({ statuses }: { statuses: ReviewMemoryProposal['status'][] }) => {
      await Promise.resolve();
      return { proposals: h.rows.filter(row => statuses.includes(row.status)), nextCursor: null };
    }
  );
  h.save.mockImplementation(async (input: ProposalDraft) => {
    if (h.saveGate) {
      await h.saveGate;
    }
    if (h.saveFailure) {
      throw new Error('Save unavailable');
    }
    const current = h.rows[0];
    if (!current) {
      throw new Error('Missing proposal');
    }
    const updated = {
      ...current,
      title: input.title,
      rationale: input.rationale,
      proposed_markdown: input.proposedMarkdown,
      status: 'edited' as const,
    };
    h.rows = [updated];
    return updated;
  });
  h.reject.mockImplementation(async () => {
    await Promise.resolve();
    const current = h.rows[0];
    if (!current) {
      throw new Error('Missing proposal');
    }
    const updated = { ...current, status: 'rejected' as const };
    h.rows = [updated];
    return updated;
  });
  h.approve.mockImplementation(async () => {
    await Promise.resolve();
    const current = h.rows[0];
    if (!current) {
      throw new Error('Missing proposal');
    }
    const updated = {
      ...current,
      status: h.approveFailure
        ? ('change_request_failed' as const)
        : ('change_request_opened' as const),
      change_request_url: h.approveFailure ? null : 'https://github.com/fixture/repository/pull/1',
    };
    h.rows = [updated];
    if (h.approveFailure) {
      throw new Error('Opening unavailable');
    }
    return updated;
  });
});

describe('review memory proposal interaction', () => {
  it('opens a localized proposal with its repository and complete editable guidance', async () => {
    const ui = await mountOpen();
    const root = ui.renderer.root;
    expect(firstRow(root).props.accessibilityLabel).toContain(i18n.t('prReview.entry.open'));
    expect(collectText(ui.renderer.toJSON())).toContain('fixture/repository');
    const fields = hosts(root, 'FormField');
    expect(fields.at(-1)?.props.defaultValue).toBe(proposal().proposed_markdown);
    ui.unmount();
  });

  it.each<PermissionState>([
    { status: 'loading' },
    { status: 'ready', canEdit: false },
    {
      status: 'error',
      refetch: () => {
        h.permissionRetry();
      },
      isRetrying: false,
    },
  ])('fails closed while permission is $status', async permission => {
    h.permission = permission;
    const ui = await mountOpen();
    expect(hosts(ui.renderer.root, 'FormField')).toHaveLength(0);
    expect(
      hosts(ui.renderer.root, 'Button').filter(node =>
        collectText(node).includes(i18n.t('common.openPullRequest'))
      )
    ).toHaveLength(0);
    expect(collectText(ui.renderer.toJSON())).toContain(proposal().proposed_markdown);
    if (permission.status === 'error') {
      press(button(ui.renderer.root, 'common.retry'));
      expect(h.permissionRetry).toHaveBeenCalledOnce();
    }
    expect(h.save).not.toHaveBeenCalled();
    expect(h.reject).not.toHaveBeenCalled();
    expect(h.approve).not.toHaveBeenCalled();
    ui.unmount();
  });

  it.each(['opening_change_request', 'change_request_opened'] as const)(
    'inspects %s without mutation controls',
    async status => {
      h.rows = [proposal(status)];
      const ui = await mountOpen();
      expect(hosts(ui.renderer.root, 'FormField')).toHaveLength(0);
      expect(hosts(ui.renderer.root, 'Button')).toHaveLength(0);
      ui.unmount();
    }
  );

  it('retains failed edits through refetch and retries Save before allowing approval', async () => {
    const ui = await mountOpen();
    h.saveFailure = true;
    change(ui.renderer.root, 'codeReviewer.reviewMemory.proposalTitle', 'Keep operation context');
    change(
      ui.renderer.root,
      'codeReviewer.reviewMemory.rationale',
      'Explain which operation failed.'
    );
    change(
      ui.renderer.root,
      'codeReviewer.overview.proposedReviewMdGuidance',
      '# Raw updated guidance'
    );
    expect(button(ui.renderer.root, 'common.openPullRequest').props.disabled).toBe(true);
    press(button(ui.renderer.root, 'common.save'));
    await waitFor(() =>
      hosts(ui.renderer.root, 'AccessibleStatus').some(
        node => node.props.message === 'Save unavailable'
      )
    );
    expect(h.error).toHaveBeenCalledWith('Save unavailable');
    expect(hosts(ui.renderer.root, 'FormField')[0]?.props.defaultValue).toBe(
      'Keep operation context'
    );
    h.saveFailure = false;
    press(button(ui.renderer.root, 'common.retry'));
    await waitFor(
      () =>
        button(ui.renderer.root, 'common.save').props.disabled === true &&
        button(ui.renderer.root, 'common.openPullRequest').props.disabled === false
    );
    expect(h.save.mock.calls.at(-1)?.[0]).toMatchObject({
      platform: 'github',
      proposalId: proposal().id,
      title: 'Keep operation context',
      rationale: 'Explain which operation failed.',
      proposedMarkdown: '# Raw updated guidance',
    });
    expect(h.rows[0]?.title).toBe('Keep operation context');
    expect(h.summary.mock.calls.length).toBeGreaterThan(1);
    press(button(ui.renderer.root, 'common.openPullRequest'));
    await waitFor(() => hosts(ui.renderer.root, 'FormField').length === 0);
    expect(h.rows[0]?.status).toBe('change_request_opened');
    ui.unmount();
  });

  it('blocks conflicting writes and dismissal while saving, then removes a dismissed proposal', async () => {
    const gate = Promise.withResolvers<undefined>();
    h.saveGate = gate.promise;
    const ui = await mountOpen();
    change(ui.renderer.root, 'codeReviewer.reviewMemory.proposalTitle', 'Updated title');
    press(button(ui.renderer.root, 'common.save'));
    await waitFor(
      () =>
        button(ui.renderer.root, 'securityAgent.analysis.action.dismiss').props.disabled === true
    );
    expect(hosts(ui.renderer.root, 'FormField').every(field => field.props.disabled === true)).toBe(
      true
    );
    const sheet = one(ui.renderer.root, 'SessionPageSheet').props as {
      onRequestDismiss: () => boolean;
    };
    expect(sheet.onRequestDismiss()).toBe(false);
    await act(async () => {
      gate.resolve(undefined);
      await gate.promise;
    });
    await waitFor(
      () =>
        button(ui.renderer.root, 'securityAgent.analysis.action.dismiss').props.disabled === false
    );
    press(button(ui.renderer.root, 'securityAgent.analysis.action.dismiss'));
    await waitFor(() => hosts(ui.renderer.root, 'SessionPageSheet').length === 0);
    expect(h.rows[0]?.status).toBe('rejected');
    expect(
      hosts(ui.renderer.root, 'Pressable').filter(node => node.props.accessibilityRole === 'button')
    ).toHaveLength(0);
    expect(h.summary.mock.calls.length).toBeGreaterThan(1);
    ui.unmount();
  });

  it('refreshes failed approval status and allows recovery', async () => {
    h.approveFailure = true;
    const ui = await mountOpen();
    press(button(ui.renderer.root, 'common.openPullRequest'));
    await waitFor(
      () =>
        hosts(ui.renderer.root, 'AccessibleStatus').some(
          node => node.props.message === 'Opening unavailable'
        ) &&
        collectText(ui.renderer.toJSON()).includes(
          i18n.t('codeReviewer.reviewMemory.status.change_request_failed')
        )
    );
    expect(h.summary.mock.calls.length).toBeGreaterThan(1);
    h.approveFailure = false;
    press(button(ui.renderer.root, 'common.retry'));
    await waitFor(() => hosts(ui.renderer.root, 'FormField').length === 0);
    expect(h.approve).toHaveBeenCalledTimes(2);
    ui.unmount();
  });

  it('keeps dirty drafts through selected-record refresh and guards closing', async () => {
    const ui = await mountOpen();
    change(ui.renderer.root, 'codeReviewer.reviewMemory.proposalTitle', 'Local draft');
    h.rows = [{ ...proposal('edited'), title: 'Remote title' }];
    await act(async () => {
      await ui.queryClient.invalidateQueries({ queryKey: ['memory', 'proposals'] });
    });
    expect(hosts(ui.renderer.root, 'FormField')[0]?.props.defaultValue).toBe('Local draft');
    expect(button(ui.renderer.root, 'common.openPullRequest').props.disabled).toBe(true);
    const sheet = one(ui.renderer.root, 'SessionPageSheet').props as {
      onRequestDismiss: () => boolean;
    };
    act(() => {
      expect(sheet.onRequestDismiss()).toBe(false);
    });
    expect(h.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ confirmLabel: i18n.t('common.discard') })
    );
    h.permission = {
      status: 'error',
      refetch: () => {
        h.permissionRetry();
      },
      isRetrying: false,
    };
    act(() => {
      ui.renderer.update(
        createElement(
          QueryClientProvider,
          { client: ui.queryClient },
          createElement(ReviewMemoryScreen, { scope: 'personal' })
        )
      );
    });
    expect(hosts(ui.renderer.root, 'FormField')).toHaveLength(0);
    h.permission = { status: 'ready', canEdit: true };
    act(() => {
      ui.renderer.update(
        createElement(
          QueryClientProvider,
          { client: ui.queryClient },
          createElement(ReviewMemoryScreen, { scope: 'personal' })
        )
      );
    });
    expect(hosts(ui.renderer.root, 'FormField')[0]?.props.defaultValue).toBe('Local draft');
    ui.unmount();
  });

  it('keeps opened proposals inspectable and opens their pull request', async () => {
    const url = 'https://github.com/fixture/repository/pull/1';
    h.rows = [{ ...proposal('change_request_opened'), change_request_url: url }];
    const ui = await mountOpen();
    expect(collectText(ui.renderer.toJSON())).toContain(proposal().rationale);
    expect(collectText(ui.renderer.toJSON())).toContain(proposal().proposed_markdown);
    press(button(ui.renderer.root, 'common.openPullRequest'));
    expect(h.openUrl).toHaveBeenCalledWith(url, { label: i18n.t('common.pullRequest') });
    expect(h.approve).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('reports already-present guidance without creating another action', async () => {
    h.approve.mockImplementation(async () => {
      await Promise.resolve();
      const updated = proposal('superseded');
      h.rows = [updated];
      return updated;
    });
    const ui = await mountOpen();
    press(button(ui.renderer.root, 'common.openPullRequest'));
    await waitFor(() =>
      collectText(ui.renderer.toJSON()).includes(
        i18n.t('codeReviewer.reviewMemory.status.superseded')
      )
    );
    expect(collectText(ui.renderer.toJSON())).toContain(
      i18n.t('codeReviewer.reviewMemory.status.superseded')
    );
    expect(h.success).toHaveBeenCalledWith(i18n.t('codeReviewer.reviewMemory.alreadyPresent'));
    expect(hosts(ui.renderer.root, 'Button')).toHaveLength(0);
    ui.unmount();
  });

  it('keeps whitespace-only edits from reaching the save API', async () => {
    const ui = await mountOpen();
    change(ui.renderer.root, 'codeReviewer.reviewMemory.rationale', '   ');
    expect(button(ui.renderer.root, 'common.save').props.disabled).toBe(true);
    expect(button(ui.renderer.root, 'common.openPullRequest').props.disabled).toBe(true);
    expect(h.save).not.toHaveBeenCalled();
    ui.unmount();
  });
});
