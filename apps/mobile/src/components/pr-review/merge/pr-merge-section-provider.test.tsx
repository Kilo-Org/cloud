// The provider merge section (s6): the overview's merge affordance on a
// GitLab MR / Bitbucket PR. The merge CTA always pushes the ref's own sheet
// route (the sheet renders the s2/s3 restrictions); the merge and auto-merge
// rows follow the capability list — GitLab gets the CTAs, Bitbucket gets the
// explicit capability banners instead of dead buttons or a silent absence. A
// terminal PR renders the terminal chip and no CTAs.

import * as React from 'react';
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { PrMergeSectionProvider } from './pr-merge-section-provider';
import { type ProviderPrRef } from '@/lib/pr-review/provider-pr-ref';

const routerPush = vi.fn();

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock('react-native', () => ({
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
}));

vi.mock('@/components/ui/icons', () => ({
  AlertTriangle: 'AlertTriangle',
  GitBranch: 'GitBranch',
  GitMerge: 'GitMerge',
  GitPullRequest: 'GitPullRequest',
  RefreshCw: 'RefreshCw',
  ShieldAlert: 'ShieldAlert',
  XCircle: 'XCircle',
}));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
// The section parts render the UI spinner; the real one reaches the motion
// policy (expo-battery), which stays unmocked in this pure harness.
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    primaryForeground: '#FFFFFF',
    foreground: '#000000',
    mutedForeground: '#6F6A61',
    destructive: '#DC2626',
  }),
}));

const GITLAB_REF: ProviderPrRef = {
  platform: 'gitlab',
  projectPath: 'group/sub/repo',
  mrIid: 12,
};
const BITBUCKET_REF: ProviderPrRef = {
  platform: 'bitbucket',
  workspace: 'acme',
  repoSlug: 'api',
  prId: 42,
};

async function mount(
  prRef: ProviderPrRef,
  state: 'open' | 'closed' | 'merged'
): Promise<TestRenderer.ReactTestRenderer> {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    await Promise.resolve();
    renderer = TestRenderer.create(createElement(PrMergeSectionProvider, { prRef, state }));
  });
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- the closure assignment cannot cross into TS's narrow
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function findButtons(renderer: TestRenderer.ReactTestRenderer, label: string): number {
  return renderer.root.findAll(
    node =>
      String(node.type) === 'Button' &&
      (node.props as Record<string, unknown>).accessibilityLabel === label
  ).length;
}

function findButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const button = renderer.root.find(
    node =>
      String(node.type) === 'Button' &&
      (node.props as Record<string, unknown>).accessibilityLabel === label
  );
  return (button.props as { onPress?: () => void }).onPress;
}

describe('PrMergeSectionProvider (s6)', () => {
  beforeEach(() => {
    routerPush.mockClear();
  });

  it('offers merge and enable-auto-merge on a GitLab merge request (capability supported)', async () => {
    const renderer = await mount(GITLAB_REF, 'open');
    expect(findButtons(renderer, 'Merge merge request')).toBe(1);
    expect(findButtons(renderer, 'Enable auto-merge')).toBe(1);
    renderer.unmount();
  });

  it('shows capability banners instead of merge CTAs on Bitbucket (no merge precondition, no auto-merge)', async () => {
    const renderer = await mount(BITBUCKET_REF, 'open');
    // Bitbucket Cloud's merge endpoint takes no revision precondition, so no
    // merge CTA is offered; auto-merge has no API either. Both unsupported
    // capabilities state their reason instead of rendering a dead button.
    expect(findButtons(renderer, 'Merge pull request')).toBe(0);
    expect(findButtons(renderer, 'Enable auto-merge')).toBe(0);
    const banners = renderer.root
      .findAll(
        node =>
          typeof node.type === 'function' &&
          (node.type as { name?: string }).name === 'PrReviewCapabilityBanner'
      )
      .map(
        node => (node.props as { capability: { supported: boolean; reason: string } }).capability
      );
    expect(banners).toEqual([
      {
        supported: false,
        reason:
          'Bitbucket Cloud does not expose a merge revision precondition, so a merge cannot be pinned to the revision you reviewed. Merge the pull request in Bitbucket Cloud.',
      },
      { supported: false, reason: 'Bitbucket Cloud does not expose auto-merge in its API' },
    ]);
    renderer.unmount();
  });

  it('pushes the merge sheet inside the GitLab ref route on press', async () => {
    const renderer = await mount(GITLAB_REF, 'open');
    act(() => {
      findButton(renderer, 'Merge merge request')?.();
    });
    expect(routerPush).toHaveBeenCalledWith(
      '/(app)/pr-review/gitlab/group/sub/repo/12/merge?mode=merge'
    );
    renderer.unmount();
  });

  it('pushes the auto-merge arm inside the ref route on the enable CTA', async () => {
    const renderer = await mount(GITLAB_REF, 'open');
    act(() => {
      findButton(renderer, 'Enable auto-merge')?.();
    });
    expect(routerPush).toHaveBeenCalledWith(
      '/(app)/pr-review/gitlab/group/sub/repo/12/merge?mode=enable-auto-merge'
    );
    renderer.unmount();
  });

  it.each<['closed' | 'merged', string]>([
    ['merged', 'Already merged'],
    ['closed', 'This merge request is closed'],
  ])(
    'renders only the terminal chip with provider wording on a %s GitLab merge request',
    async (state, label) => {
      const renderer = await mount(GITLAB_REF, state);
      expect(renderer.root.findAll(node => String(node.type) === 'Button')).toHaveLength(0);
      expect(
        renderer.root.findAll(node => String(node.type) === 'Text' && node.props.children === label)
      ).toHaveLength(1);
      renderer.unmount();
    }
  );
});
