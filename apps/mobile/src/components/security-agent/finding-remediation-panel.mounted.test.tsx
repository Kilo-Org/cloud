/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

// Finding-remediation progress timeline: the panel renders the ordered
// remediation audit events (queued → pr_opened, or a terminal event) above the
// attempt history. The server always returns `remediationTimeline` and the
// query is not persisted, so the field is always present.

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FindingRemediationPanel } from './finding-remediation-panel';
import { type SecurityAnalysis } from '@/lib/security-agent';

const texts = vi.hoisted(() => ({ items: [] as string[] }));
const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  prReviewEnabled: true,
  openExternalUrl: vi.fn(),
}));

vi.mock('react-native', () => ({
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}));
vi.mock('@/lib/analytics/posthog', () => ({
  FEATURE_FLAG_PR_REVIEW: 'mobile-pr-review',
  useFeatureFlag: () => mocks.prReviewEnabled,
}));
vi.mock('@/lib/external-link', () => ({
  openExternalUrl: mocks.openExternalUrl,
}));
vi.mock('@/components/ui/icons', () => ({
  Wrench: 'Wrench',
}));
vi.mock('@/components/security-agent/collapsible-section', () => ({
  CollapsibleSection: (props: { children?: unknown }) => props.children ?? null,
}));
vi.mock('@/components/security-agent/finding-status-badge', () => ({
  FindingStatusBadge: () => null,
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: () => null }));
vi.mock('@/components/query-error', () => ({ QueryError: () => null }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/kv-row', () => ({ KvRow: () => null }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: () => null }));
vi.mock('@/components/ui/text', () => ({
  Text: (props: { children?: unknown }) => {
    if (typeof props.children === 'string') {
      texts.items.push(props.children);
    }
    return null;
  },
}));
vi.mock('@/lib/hooks/use-security-remediation', () => ({
  useStartSecurityRemediation: () => ({ mutate: vi.fn(), isPending: false }),
  useRetrySecurityRemediation: () => ({ mutate: vi.fn(), isPending: false }),
  useCancelSecurityRemediation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    primaryForeground: '#fff',
    foreground: '#000',
    mutedForeground: '#666',
  }),
}));
vi.mock('@kilocode/app-shared/security-agent', () => ({
  formatRemediationOrigin: (origin: string) => origin,
  formatValidationEvidenceEntry: () => '',
  getRemediationStatusPresentation: () => ({
    label: 'Not started',
    tone: 'neutral',
    icon: 'clock',
    spinning: false,
  }),
  getRemediationUnavailableCopy: () => null,
}));

type R = TestRenderer.ReactTestRenderer;

function analysisFixture(overrides: Record<string, unknown> = {}): SecurityAnalysis {
  return {
    findingState: { status: 'open' },
    status: 'completed',
    startedAt: null,
    completedAt: null,
    error: null,
    analysis: null,
    sessionId: null,
    cliSessionId: null,
    remediationSummary: null,
    remediationCapability: {
      canStart: false,
      startReason: 'finding_not_open',
      canRetry: false,
      retryReason: 'finding_not_open',
      canCancel: false,
      cancelAttemptId: null,
    },
    remediationAttempts: [],
    remediationTimeline: [],
    ...overrides,
  } as unknown as SecurityAnalysis;
}

function renderPanel(analysis: SecurityAnalysis): R {
  const ref: { current: R | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(FindingRemediationPanel, {
        scope: 'personal',
        findingId: 'finding-1',
        analysis,
        isLoading: false,
        isError: false,
        onRetry: () => undefined,
      })
    );
  });
  const r = ref.current;
  if (!r) {
    throw new Error('renderer was not created');
  }
  return r;
}

function pressButtons(r: R): void {
  act(() => {
    for (const node of r.root.findAll(
      n => typeof n.type === 'string' && (n.type as string) === 'Button'
    )) {
      const onPress = node.props.onPress as (() => void) | undefined;
      onPress?.();
    }
  });
}

describe('FindingRemediationPanel remediation timeline', () => {
  beforeEach(() => {
    texts.items = [];
  });

  it('renders remediation timeline labels in order', () => {
    renderPanel(
      analysisFixture({
        remediationTimeline: [
          { action: 'security.remediation.queued', occurredAt: '2026-04-29T01:16:12.945Z' },
          { action: 'security.remediation.pr_opened', occurredAt: '2026-04-29T02:00:00.000Z' },
        ],
      })
    );

    const queuedIndex = texts.items.indexOf('Remediation requested');
    const prOpenedIndex = texts.items.indexOf('PR opened');
    expect(queuedIndex).toBeGreaterThanOrEqual(0);
    expect(prOpenedIndex).toBeGreaterThan(queuedIndex);
  });

  it('renders terminal labels for failed, blocked, no_changes_needed, and cancelled', () => {
    renderPanel(
      analysisFixture({
        remediationTimeline: [
          { action: 'security.remediation.failed', occurredAt: '2026-04-29T01:00:00.000Z' },
          { action: 'security.remediation.blocked', occurredAt: '2026-04-29T01:01:00.000Z' },
          {
            action: 'security.remediation.no_changes_needed',
            occurredAt: '2026-04-29T01:02:00.000Z',
          },
          { action: 'security.remediation.cancelled', occurredAt: '2026-04-29T01:03:00.000Z' },
        ],
      })
    );

    expect(texts.items).toContain('Remediation failed');
    expect(texts.items).toContain('Remediation blocked');
    expect(texts.items).toContain('No changes needed');
    expect(texts.items).toContain('Cancelled');
  });

  it('renders nothing extra when the timeline is empty', () => {
    renderPanel(analysisFixture({ remediationTimeline: [] }));

    expect(texts.items).not.toContain('Progress');
    expect(texts.items).not.toContain('Remediation requested');
  });
});

describe('FindingRemediationPanel pull request navigation', () => {
  beforeEach(() => {
    texts.items = [];
    mocks.routerPush.mockReset();
    mocks.openExternalUrl.mockReset();
    mocks.prReviewEnabled = true;
  });

  it('navigates in-app for a github.com PR URL when the flag is on', () => {
    const r = renderPanel(
      analysisFixture({
        remediationSummary: {
          status: 'pr_opened',
          prUrl: 'https://github.com/kilo/kilo/pull/123',
          prNumber: 123,
          prDraft: false,
          outcomeSummary: null,
        },
      })
    );

    pressButtons(r);

    expect(mocks.routerPush).toHaveBeenCalledWith('/(app)/pr-review/kilo/kilo/123');
    expect(mocks.openExternalUrl).not.toHaveBeenCalled();
  });

  it('falls back to the browser when the flag is off', () => {
    mocks.prReviewEnabled = false;
    const r = renderPanel(
      analysisFixture({
        remediationSummary: {
          status: 'pr_opened',
          prUrl: 'https://github.com/kilo/kilo/pull/123',
          prNumber: 123,
          prDraft: false,
          outcomeSummary: null,
        },
      })
    );

    pressButtons(r);

    expect(mocks.routerPush).not.toHaveBeenCalled();
    expect(mocks.openExternalUrl).toHaveBeenCalledWith('https://github.com/kilo/kilo/pull/123', {
      label: 'pull request',
    });
  });

  it('falls back to the browser for a non-GitHub URL', () => {
    const r = renderPanel(
      analysisFixture({
        remediationSummary: {
          status: 'pr_opened',
          prUrl: 'https://gitlab.com/kilo/kilo/-/merge_requests/123',
          prNumber: 123,
          prDraft: false,
          outcomeSummary: null,
        },
      })
    );

    pressButtons(r);

    expect(mocks.routerPush).not.toHaveBeenCalled();
    expect(mocks.openExternalUrl).toHaveBeenCalledWith(
      'https://gitlab.com/kilo/kilo/-/merge_requests/123',
      { label: 'pull request' }
    );
  });

  it('routes both the summary and attempt buttons in-app', () => {
    const r = renderPanel(
      analysisFixture({
        remediationSummary: {
          status: 'pr_opened',
          prUrl: 'https://github.com/kilo/kilo/pull/123',
          prNumber: 123,
          prDraft: false,
          outcomeSummary: null,
        },
        remediationAttempts: [
          {
            id: 'attempt-1',
            attemptNumber: 1,
            status: 'pr_opened',
            prUrl: 'https://github.com/kilo/kilo/pull/456',
            prNumber: 456,
            prDraft: false,
            origin: 'manual',
            remediationModelSlug: 'gpt-5',
            branchName: 'fix/thing',
            updatedAt: '2026-04-29T02:00:00.000Z',
            cancellationRequestedAt: null,
            validationEvidence: [],
            riskNotes: null,
            draftReason: null,
            blockedReason: null,
            lastErrorRedacted: null,
          },
        ],
      })
    );

    pressButtons(r);

    expect(mocks.routerPush).toHaveBeenCalledTimes(2);
    expect(mocks.routerPush).toHaveBeenNthCalledWith(1, '/(app)/pr-review/kilo/kilo/123');
    expect(mocks.routerPush).toHaveBeenNthCalledWith(2, '/(app)/pr-review/kilo/kilo/456');
    expect(mocks.openExternalUrl).not.toHaveBeenCalled();
  });
});
