/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { ProductChoices } from '@/components/home/product-choices';
import { getCodeReviewerProfilePath, getPrReviewEntryPath } from '@/lib/profile-agent-navigation';
import { getSecurityAgentPath } from '@/lib/security-agent';

const push = vi.hoisted(() => vi.fn());
const prReviewEnabled = vi.hoisted(() => ({ value: true }));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push }),
}));
vi.mock('react-native', () => ({
  View: 'View',
}));
vi.mock('@/components/ui/configure-row', () => ({
  ConfigureRow: 'ConfigureRow',
}));
vi.mock('@/components/home/section-header', () => ({
  SectionHeader: 'SectionHeader',
}));
vi.mock('@/components/ui/icons', () => ({
  GitMerge: 'GitMerge',
  GitPullRequest: 'GitPullRequest',
  ShieldCheck: 'ShieldCheck',
}));
vi.mock('@/lib/analytics/posthog', () => ({
  FEATURE_FLAG_PR_REVIEW: 'mobile-pr-review',
  useFeatureFlag: () => prReviewEnabled.value,
}));

function rows(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'ConfigureRow'
  );
}

function rowByTitle(
  root: TestRenderer.ReactTestInstance,
  title: string
): TestRenderer.ReactTestInstance | undefined {
  return rows(root).find(row => row.props.title === title);
}

function pressRow(root: TestRenderer.ReactTestInstance, title: string): void {
  const onPress = rowByTitle(root, title)?.props.onPress as (() => void) | undefined;
  onPress?.();
}

async function mountProductChoices(
  organizationId: string | null
): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(ProductChoices, { organizationId }));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

async function unmount(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    renderer.unmount();
  });
}

describe('ProductChoices', () => {
  it('renders all three product rows when PR Review is enabled', async () => {
    prReviewEnabled.value = true;
    const renderer = await mountProductChoices('org-1');
    expect(rows(renderer.root).map(row => row.props.title)).toEqual([
      'Code Reviewer',
      'Security Agent',
      'PR Review',
    ]);
    await unmount(renderer);
  });

  it('navigates each row to its product path', async () => {
    prReviewEnabled.value = true;
    push.mockClear();
    const renderer = await mountProductChoices('org-1');

    pressRow(renderer.root, 'Code Reviewer');
    expect(push).toHaveBeenCalledWith(getCodeReviewerProfilePath('org-1'));

    pressRow(renderer.root, 'Security Agent');
    expect(push).toHaveBeenCalledWith(getSecurityAgentPath('org-1'));

    pressRow(renderer.root, 'PR Review');
    expect(push).toHaveBeenCalledWith(getPrReviewEntryPath());

    await unmount(renderer);
  });

  it('falls back to the personal scope when no organization is selected', async () => {
    prReviewEnabled.value = true;
    push.mockClear();
    const renderer = await mountProductChoices(null);

    pressRow(renderer.root, 'Code Reviewer');
    expect(push).toHaveBeenCalledWith(getCodeReviewerProfilePath('personal'));

    pressRow(renderer.root, 'Security Agent');
    expect(push).toHaveBeenCalledWith(getSecurityAgentPath('personal'));

    await unmount(renderer);
  });

  it('hides PR Review when the flag is false', async () => {
    prReviewEnabled.value = false;
    const renderer = await mountProductChoices('org-1');
    expect(rows(renderer.root).map(row => row.props.title)).toEqual([
      'Code Reviewer',
      'Security Agent',
    ]);
    prReviewEnabled.value = true;
    await unmount(renderer);
  });
});
