/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as comment-row.test.tsx) */
// The provider merge section (s6): the overview's merge affordance on a
// GitLab MR / Bitbucket PR. The merge CTA always pushes the ref's own sheet
// route (the sheet renders the s2/s3 restrictions); the auto-merge row
// follows the capability list — GitLab gets the enable CTA, Bitbucket gets
// the explicit capability banner instead of a dead button or a silent
// absence. A terminal PR renders the terminal chip and no CTAs.

import * as React from 'react';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
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

// The capability banner fades in as conditional content (AGENTS.md); the
// DOM-free renderer only needs the animated host as a string component.
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
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

function findBanner(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'function' &&
      (node.type as { name?: string }).name === 'PrReviewCapabilityBanner'
  );
}

function textsOf(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => String(node.type) === 'Text')
    .map(node => (node.props as { children?: unknown }).children)
    .filter((child): child is string => typeof child === 'string');
}

describe('PrMergeSectionProvider (s6)', () => {
  beforeEach(() => {
    routerPush.mockClear();
  });

  it('offers merge and enable-auto-merge on a GitLab merge request (capability supported)', async () => {
    const renderer = await mount(GITLAB_REF, 'open');
    expect(findButtons(renderer, 'Merge merge request')).toBe(1);
    expect(findButtons(renderer, 'Enable auto-merge')).toBe(1);
    // Happy state: a supported capability renders no banner and no
    // unavailable copy — the enable CTA is the affordance.
    expect(findBanner(renderer)).toHaveLength(0);
    expect(textsOf(renderer)).not.toContain('Auto-merge is not available');
    renderer.unmount();
  });

  it('offers merge with the localized capability banner on Bitbucket (auto-merge unsupported)', async () => {
    const renderer = await mount(BITBUCKET_REF, 'open');
    expect(findButtons(renderer, 'Merge pull request')).toBe(1);
    // Non-retryable unhappy state: the banner explains, and carries no CTA.
    expect(findButtons(renderer, 'Enable auto-merge')).toBe(0);
    const [banner] = findBanner(renderer);
    // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- guard the one-banner invariant with a readable failure
    if (!banner) {
      throw new Error('the Bitbucket arm renders no capability banner');
    }
    expect(
      (banner.props as { capability: { supported: boolean; reason: string } }).capability
    ).toEqual({
      supported: false,
      reason: 'Bitbucket Cloud does not expose auto-merge in its API',
    });
    // The section hands catalog copy, not the shared English constant.
    expect(
      (banner.props as { title?: string; reason?: string }).title
    ).toBe('Auto-merge is not available');
    expect(
      (banner.props as { title?: string; reason?: string }).reason
    ).toBe('Bitbucket Cloud does not expose auto-merge in its API');
    const texts = textsOf(renderer);
    expect(texts).toContain('Auto-merge is not available');
    expect(texts).toContain('Bitbucket Cloud does not expose auto-merge in its API');
    renderer.unmount();
  });

  it('pushes the merge sheet inside the GitLab ref route on press', async () => {
    const renderer = await mount(GITLAB_REF, 'open');
    act(() => {
      findButton(renderer, 'Merge merge request')?.();
    });
    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/(app)/pr-review/gitlab/group/sub/repo/12/merge',
      params: { mode: 'merge' },
    });
    renderer.unmount();
  });

  it('pushes the auto-merge arm inside the ref route on the enable CTA', async () => {
    const renderer = await mount(GITLAB_REF, 'open');
    act(() => {
      findButton(renderer, 'Enable auto-merge')?.();
    });
    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/(app)/pr-review/gitlab/group/sub/repo/12/merge',
      params: { mode: 'enable-auto-merge' },
    });
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
