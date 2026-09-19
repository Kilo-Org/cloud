// P3-H-11a: the PR state chip icon must carry its tone through a theme color
// token (`color`), not a Tailwind `className`. This test renders `PrStateChip`
// for every tone and asserts the icon `color` equals the matching `lightColors`
// token, while the label `Text` keeps its tone class.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import type * as ReactI18next from 'react-i18next';

import { lightColors } from '@/lib/hooks/use-theme-colors';

import { describePrState, PrRefsRow, PrStateChip } from './pr-review-overview-parts';

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
      node =>
        typeof node.type === 'string' &&
        ((node.type as string) === 'GitMerge' || (node.type as string) === 'GitPullRequest')
    );
    expect(iconNode.props.color).toBe(lightColors[token]);

    const textNode = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'Text'
    );
    expect(textNode.props.className).toContain(toneClass);

    renderer.unmount();
  });
});

function renderRefsRow(): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    renderer = TestRenderer.create(
      createElement(PrRefsRow, {
        baseRef: 'main',
        headRef: 'feat/session-and-pr-entities-in-search-1092',
        headRepoFullName: 'Kilo-Org/cloud',
        isCrossRepo: true,
      })
    );
  });
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition
  if (!renderer) {
    throw new Error('Failed to create test renderer');
  }
  return renderer;
}

describe('PrRefsRow truncation', () => {
  it('shrinks the head ref so it ellipsizes instead of hard-clipping at the edge', () => {
    const renderer = renderRefsRow();

    const texts = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'Text'
    );
    // Head ref, arrow, base ref — the head is first.
    const [head, arrow, base] = texts;
    if (!head || !arrow || !base) {
      throw new Error('PrRefsRow did not render its three text nodes');
    }
    expect(head.props.className).toContain('min-w-0');
    expect(head.props.className).toContain('shrink');
    expect(head.props.numberOfLines).toBe(1);
    expect(head.props.ellipsizeMode).toBe('middle');

    // The arrow and the short base ref hold their width.
    expect(arrow.props.className).toContain('shrink-0');
    expect(base.props.className).toContain('shrink-0');

    renderer.unmount();
  });
});
