import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SessionReadOnlyFooterPlaceholder } from './session-detail-skeleton';

// Vitest hoists these above the component import, which is what keeps the real
// skeleton, blur bar and reanimated out of this suite.
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeOut: { duration: () => ({}) },
}));
vi.mock('@/components/ui/blur-bar', () => ({ BlurBar: 'BlurBar' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));

function walk(node: unknown, visit: (el: React.ReactElement) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      walk(child, visit);
    }
    return;
  }
  if (React.isValidElement(node)) {
    visit(node);
    walk((node.props as { children?: unknown }).children, visit);
  }
}

function classNameOf(el: React.ReactElement): string {
  return (el.props as { className?: string }).className ?? '';
}

// The reserved bottom slot was a blank tinted block at the design review: its
// bars carried the shared Skeleton's default `bg-muted`, and `--muted` equals
// `--secondary` in BOTH themes (apps/mobile/src/global.css), so they painted the
// footer's own fill. `bg-muted-soft` is the one gray that differs from it, the
// same token the profile and pull-request cards reserve their space with. The
// geometry the footer lands on is pinned too, so the reserved area keeps being
// the footer's shape rather than an empty panel.
describe('SessionReadOnlyFooterPlaceholder', () => {
  it('reserves the footer shape in bars that stand off its own fill', () => {
    // eslint-disable-next-line new-cap
    const root = SessionReadOnlyFooterPlaceholder() as React.ReactElement;

    const containers = classNameOf(root).split(/\s+/);
    expect(containers).toContain('bg-secondary');
    expect(containers).toContain('border-t');
    expect(containers).toContain('px-4');
    expect(containers).toContain('py-3');

    const bars: React.ReactElement[] = [];
    walk(root, el => {
      if (el.type === 'Skeleton') {
        bars.push(el);
      }
    });
    expect(bars).toHaveLength(2);
    // The footer note's line box, centred, then its action button's floor.
    const [noteBar, buttonBar] = bars.map(bar => classNameOf(bar));
    expect(noteBar).toContain('h-[17.5px]');
    expect(noteBar).toContain('w-40');
    expect(noteBar).toContain('mx-auto');
    expect(buttonBar).toContain('h-[48px]');

    for (const bar of bars) {
      const tokens = classNameOf(bar).split(/\s+/);
      expect(tokens).toContain('bg-muted-soft');
      // The collision: bare `bg-muted` is the fill this footer already paints.
      expect(tokens).not.toContain('bg-muted');
    }
  });
});
