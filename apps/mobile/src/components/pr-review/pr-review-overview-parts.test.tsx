// P3-H-11a: the PR state chip icon must carry its tone through a theme color
// token (`color`), not a Tailwind `className`. This test renders `PrStateChip`
// for every tone and asserts the icon `color` equals the matching `lightColors`
// token, while the label `Text` keeps its tone class.

/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to test React/RN structure under vitest */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type * as ReactI18next from 'react-i18next';

import { lightColors } from '@/lib/hooks/use-theme-colors';

import { describePrState, PrStateChip } from './pr-review-overview-parts';

vi.mock('react-native', () => ({
  View: 'View',
  useColorScheme: () => 'light',
}));

vi.mock('expo-router', () => ({ DarkTheme: {}, DefaultTheme: {} }));

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

vi.mock('@/components/ui/icons', () => ({
  GitBranch: 'GitBranch',
  GitCommit: 'GitCommit',
  GitMerge: 'GitMerge',
  GitPullRequest: 'GitPullRequest',
  Plus: 'Plus',
}));

vi.mock('@/components/ui/image', () => ({ Image: 'Image' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

type ChipCase = {
  name: string;
  args: Parameters<typeof describePrState>[0];
  token: keyof typeof lightColors;
  toneClass: string;
};

const cases: ChipCase[] = [
  {
    name: 'merged (muted)',
    args: { state: 'merged', draft: false, reviewDecision: null },
    token: 'mutedForeground',
    toneClass: 'text-muted-foreground',
  },
  {
    name: 'open approved (good)',
    args: { state: 'open', draft: false, reviewDecision: 'APPROVED' },
    token: 'good',
    toneClass: 'text-good',
  },
  {
    name: 'open changes requested (destructive)',
    args: { state: 'open', draft: false, reviewDecision: 'CHANGES_REQUESTED' },
    token: 'destructive',
    toneClass: 'text-destructive',
  },
  {
    name: 'open review required (warn)',
    args: { state: 'open', draft: false, reviewDecision: 'REVIEW_REQUIRED' },
    token: 'warn',
    toneClass: 'text-warn',
  },
];

function renderChip(args: ChipCase['args']): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    renderer = TestRenderer.create(
      createElement(PrStateChip, { descriptor: describePrState(args) })
    );
  });
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition
  if (!renderer) {
    throw new Error('Failed to create test renderer');
  }
  return renderer;
}

describe('PrStateChip tone color', () => {
  it.each(cases)('$name', ({ args, token, toneClass }) => {
    const renderer = renderChip(args);

    const iconNode = renderer.root.find(
      node => node.type === 'GitMerge' || node.type === 'GitPullRequest'
    );
    expect(iconNode.props.color).toBe(lightColors[token]);

    const textNode = renderer.root.find(node => node.type === 'Text');
    expect(textNode.props.className).toContain(toneClass);

    renderer.unmount();
  });
});
