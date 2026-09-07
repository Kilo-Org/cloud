// The sidebar metadata sections render only what GitHub reported: an empty
// array draws no heading, and a reviewer's state picks both its icon and its
// theme-color token (Lucide icons take `color`, never a Tailwind class).

/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to test React/RN structure under vitest */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type * as ReactI18next from 'react-i18next';

import { lightColors } from '@/lib/hooks/use-theme-colors';
import { type PrOverviewDto } from '@/lib/pr-review/merge/merge-blocked-reasons';

import { PrOverviewMeta } from './pr-review-meta-parts';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  useColorScheme: () => 'light',
}));

vi.mock('expo-router', () => ({ DarkTheme: {}, DefaultTheme: {} }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn() }));

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

vi.mock('@/components/ui/icons', () => ({
  CircleCheck: 'CircleCheck',
  CircleDot: 'CircleDot',
  CircleX: 'CircleX',
  Clock: 'Clock',
  MessageSquare: 'MessageSquare',
  UserRound: 'UserRound',
  Users: 'Users',
}));

vi.mock('@/components/ui/image', () => ({ Image: 'Image' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

function overview(overrides: Partial<PrOverviewDto> = {}): PrOverviewDto {
  // Only the fields PrOverviewMeta reads; the rest of the DTO is irrelevant here.
  const dto: Pick<
    PrOverviewDto,
    | 'assignees'
    | 'closedAt'
    | 'createdAt'
    | 'labels'
    | 'linkedIssues'
    | 'mergedAt'
    | 'mergedBy'
    | 'reviewers'
    | 'state'
    | 'updatedAt'
  > = {
    state: 'open',
    createdAt: '2026-03-01T12:00:00Z',
    updatedAt: '2026-03-02T09:30:00Z',
    closedAt: null,
    mergedAt: null,
    mergedBy: null,
    labels: [],
    assignees: [],
    reviewers: [],
    linkedIssues: [],
    ...overrides,
  };
  return dto as PrOverviewDto;
}

function render(dto: PrOverviewDto) {
  const rendered: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  act(() => {
    rendered.current = TestRenderer.create(createElement(PrOverviewMeta, { overview: dto }));
  });
  if (!rendered.current) {
    throw new Error('render produced no tree');
  }
  return rendered.current;
}

describe('PrOverviewMeta', () => {
  it('draws only the timeline line when GitHub reported no sidebar metadata', () => {
    const renderer = render(overview());
    // The timeline is the single Text; no section heading icon is mounted.
    expect(renderer.root.findAll(node => String(node.type) === 'Users')).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'UserRound')).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'CircleDot')).toHaveLength(0);
  });

  it('paints a label chip with GitHub’s own color and a readable text color', () => {
    const renderer = render(overview({ labels: [{ name: 'bug', color: 'd73a4a' }] }));
    const chip = renderer.root.find(
      node =>
        String(node.type) === 'View' &&
        (node.props.style as { backgroundColor?: string } | undefined)?.backgroundColor ===
          '#d73a4a'
    );
    expect(chip).toBeDefined();
    const label = renderer.root.find(
      node => String(node.type) === 'Text' && node.props.children === 'bug'
    );
    expect(label.props.style).toEqual({ color: '#ffffff' });
  });

  it('falls back to the neutral chip when the label color is not a hex triplet', () => {
    const renderer = render(overview({ labels: [{ name: 'odd', color: 'nope' }] }));
    const label = renderer.root.find(
      node => String(node.type) === 'Text' && node.props.children === 'odd'
    );
    expect(label.props.style).toBeUndefined();
    expect(label.props.className).toContain('text-foreground');
  });

  it('gives each reviewer state its own icon and theme color token', () => {
    const renderer = render(
      overview({
        reviewers: [
          { login: 'ada', avatarUrl: null, state: 'APPROVED' },
          { login: 'grace', avatarUrl: null, state: 'CHANGES_REQUESTED' },
          { login: 'ken', avatarUrl: null, state: 'PENDING' },
        ],
      })
    );
    const approved = renderer.root.find(node => String(node.type) === 'CircleCheck');
    expect(approved.props.color).toBe(lightColors.good);
    const changes = renderer.root.find(node => String(node.type) === 'CircleX');
    expect(changes.props.color).toBe(lightColors.destructive);
    const pending = renderer.root.find(node => String(node.type) === 'Clock');
    expect(pending.props.color).toBe(lightColors.mutedForeground);
  });

  it('opens a linked issue in the browser', async () => {
    const { openBrowserAsync } = await import('expo-web-browser');
    const renderer = render(
      overview({
        linkedIssues: [
          {
            number: 42,
            title: 'Flux capacitor leaks',
            url: 'https://github.com/kilo/flux/issues/42',
            closed: false,
          },
        ],
      })
    );
    const row = renderer.root.find(node => String(node.type) === 'Pressable');
    act(() => {
      (row.props.onPress as () => void)();
    });
    expect(openBrowserAsync).toHaveBeenCalledWith('https://github.com/kilo/flux/issues/42');
  });
});
