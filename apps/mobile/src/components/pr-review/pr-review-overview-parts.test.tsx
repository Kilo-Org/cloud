// P3-H-11a: the PR state chip icon must carry its tone through a theme color
// token (`color`), not a Tailwind `className`. This test renders `PrStateChip`
// for every tone and asserts the icon `color` equals the matching `lightColors`
// token, while the label `Text` keeps its tone class.

// Use the compiler's CommonJS entry, matching Metro and check-classes.mjs.
// eslint-disable-next-line import/no-nodejs-modules
import { createRequire } from 'node:module';
import { createElement } from 'react';
import type * as NativeCompiler from 'react-native-css/compiler';
import { compile as compileTailwind } from 'tailwindcss';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import type * as ReactI18next from 'react-i18next';

import { lightColors } from '@/lib/hooks/use-theme-colors';

import {
  describePrState,
  formatPrCounts,
  PrRefsRow,
  PrStateChip,
} from './pr-review-overview-parts';

const { compile: compileNative } = createRequire(import.meta.url)(
  'react-native-css/compiler'
) as typeof NativeCompiler;

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

vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalArrowLeft: 'DirectionalArrowLeft',
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

function renderRefs(props: Parameters<typeof PrRefsRow>[0]): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    renderer = TestRenderer.create(createElement(PrRefsRow, props));
  });
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition
  if (!renderer) {
    throw new Error('Failed to create test renderer');
  }
  return renderer;
}

describe('PrRefsRow width constraints', () => {
  it('compiles the width constraints to native shrink and percentage sizing', async () => {
    const utilities = await compileTailwind('@tailwind utilities;');
    const native = compileNative(utilities.build(['shrink', 'max-w-1/2']));

    expect(native.warnings()).toEqual({});
    expect(native.stylesheet()).toMatchObject({
      s: [
        ['max-w-1/2', [{ d: [{ maxWidth: '50%' }] }]],
        ['shrink', [{ d: [{ flexShrink: 1 }] }]],
      ],
    });
  });

  it.each([
    {
      name: 'the reported version-bump branch into main',
      headRef: 'kilo-app-version-bump-1.0.11',
      baseRef: 'main',
      headRepoFullName: 'Kilo-Org/cloud',
      isCrossRepo: false,
      displayedHead: 'kilo-app-version-bump-1.0.11',
    },
    {
      name: 'a long fork-qualified source branch',
      headRef: 'fix/preserve-pull-request-branch-margins',
      baseRef: 'main',
      headRepoFullName: 'contributor-with-a-long-name/cloud',
      isCrossRepo: true,
      displayedHead: 'contributor-with-a-long-name/cloud:fix/preserve-pull-request-branch-margins',
    },
    {
      name: 'long source and target branches',
      headRef: 'fix/preserve-pull-request-branch-margins',
      baseRef: 'release/a-long-target-branch-that-must-not-push-out-the-source',
      headRepoFullName: null,
      isCrossRepo: false,
      displayedHead: 'fix/preserve-pull-request-branch-margins',
    },
    {
      name: 'a fork whose source repository is unavailable',
      headRef: 'fix',
      baseRef: 'main',
      headRepoFullName: null,
      isCrossRepo: true,
      displayedHead: 'fix',
    },
  ])('constrains $name without dropping either ref', ({ name: _name, displayedHead, ...props }) => {
    const renderer = renderRefs(props);
    const [head, base] = renderer.root.findAllByType('Text');
    if (!head || !base) {
      throw new Error('Expected a source and a target ref');
    }

    expect(head.children.filter(child => typeof child === 'string').join('')).toBe(displayedHead);
    expect(base.children).toEqual([props.baseRef]);

    // The flow reads between the two refs as one mirrored icon, sized to the
    // 13 px ref text and colored like the row's branch mark, so it centers on
    // the row instead of riding a text glyph's baseline.
    const rowChildren = renderer.root
      .findByType('View')
      .children.map(child => (typeof child === 'string' ? child : child.type));
    expect(rowChildren).toEqual(['GitBranch', 'Text', 'DirectionalArrowLeft', 'Text']);
    expect(renderer.root.findByType('DirectionalArrowLeft').props).toMatchObject({
      size: 13,
      color: lightColors.mutedForeground,
    });

    // Yoga defaults row children to flexShrink: 0. A line limit alone does not
    // stop a long source from pushing the target beyond the content margin.
    expect((head.props.className as string).split(' ')).toContain('shrink');
    // Leave room for the source even when the target is also very long, while
    // short targets like main keep their intrinsic width instead of shrinking.
    expect((base.props.className as string).split(' ')).toContain('max-w-1/2');
    for (const ref of [head, base]) {
      expect(ref.props.numberOfLines).toBe(1);
      expect(ref.props.ellipsizeMode).toBe('middle');
    }

    renderer.unmount();
  });
});

describe('PrRefsRow truncation', () => {
  it('shrinks the head ref so it ellipsizes instead of hard-clipping at the edge', () => {
    const renderer = renderRefs({
      baseRef: 'main',
      headRef: 'feat/session-and-pr-entities-in-search-1092',
      headRepoFullName: 'Kilo-Org/cloud',
      isCrossRepo: true,
    });

    const texts = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'Text'
    );
    // Head ref, then the target — the head is first.
    const [head, base] = texts;
    if (!head || !base) {
      throw new Error('PrRefsRow did not render both refs');
    }
    expect(head.props.className).toContain('min-w-0');
    expect(head.props.className).toContain('shrink');
    expect(head.props.numberOfLines).toBe(1);
    expect(head.props.ellipsizeMode).toBe('middle');

    // The short base ref holds its width.
    expect(base.props.className).toContain('shrink-0');

    renderer.unmount();
  });
});

describe('formatPrCounts', () => {
  it('keeps each sign before its number inside one isolated left-to-right run', () => {
    // Bidi on a right-to-left screen moves a sign behind its number unless the
    // counts are isolated, so the line read "3+ / 1-" there.
    const line = formatPrCounts(3, 1);
    expect(line.startsWith('\u2066')).toBe(true);
    expect(line.endsWith('\u2069')).toBe(true);

    const counts = line.slice(1, -1);
    const added = counts.indexOf('+');
    const removed = counts.indexOf('\u2212');
    expect(added).toBeGreaterThanOrEqual(0);
    expect(removed).toBeGreaterThan(added);
    expect(counts.indexOf('3')).toBe(added + 1);
    expect(counts.indexOf('1')).toBe(removed + 1);
  });
});
