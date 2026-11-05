import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  SessionComposerSkeleton,
  SessionReadOnlyFooterPlaceholder,
} from './session-detail-skeleton';

const platform = vi.hoisted(() => ({ os: 'android', fontScale: 1 }));

// Vitest hoists these above the component import, which is what keeps the real
// skeleton and blur bar out of this suite.
vi.mock('react-native', () => ({
  View: 'View',
  Platform: {
    get OS() {
      return platform.os;
    },
  },
  useWindowDimensions: () => ({ fontScale: platform.fontScale }),
}));
// The skeleton reads the live font scale, which prefers the app's own module
// and only falls back to the window's; the suite keeps the fallback path.
vi.mock('@/lib/font-scale/system-font-scale-context', () => ({
  useLiveFontScale: () => platform.fontScale,
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

// The composer's own row, in points. This app's rem is 14 pt, so a scale step
// like `h-11` paints 38.5 pt and leaves the slot short of the composer that
// replaces it — the slot moved the transcript when it resolved. The controls
// keep ChatComposerInputRow's CONTROL_HIT_TARGET: 48 on Android, 44 on iOS.
describe('SessionComposerSkeleton', () => {
  function skeletonBars(platformOs: 'android' | 'ios', fontScale = 1): string[] {
    platform.os = platformOs;
    platform.fontScale = fontScale;
    // eslint-disable-next-line new-cap
    const root = SessionComposerSkeleton() as React.ReactElement;
    const bars: string[] = [];
    walk(root, el => {
      if (el.type === 'Skeleton') {
        bars.push(classNameOf(el));
      }
    });
    return bars;
  }

  function fieldBoxHeight(fontScale: number): number {
    platform.fontScale = fontScale;
    // eslint-disable-next-line new-cap
    const root = SessionComposerSkeleton() as React.ReactElement;
    const heights: number[] = [];
    walk(root, el => {
      const style = (el.props as { style?: { height?: number } }).style;
      if (style?.height !== undefined) {
        heights.push(style.height);
      }
    });
    return heights[0] ?? -1;
  }

  it('stands the row on the composer field and both controls', () => {
    for (const [platformOs, control] of [
      ['android', 'h-[48px] w-[48px]'],
      ['ios', 'h-[44px] w-[44px]'],
    ] as const) {
      const bars = skeletonBars(platformOs);
      expect(bars).toHaveLength(3);
      const [field = [], voice = [], send = []] = bars.map(className => className.split(/\s+/));
      expect(field).toEqual(expect.arrayContaining(['h-full', 'w-full', 'rounded-[20px]']));
      for (const trailing of [voice, send]) {
        expect(trailing).toEqual(expect.arrayContaining(control.split(' ')));
        expect(trailing).toContain('ms-3');
        expect(trailing).toContain('rounded-full');
      }
      // No scale steps: `h-11` is 38.5 pt and `h-12` 42 pt at this rem.
      for (const tokens of [field, voice, send]) {
        expect(tokens.filter(token => /^h-\d+$/.test(token))).toEqual([]);
        expect(tokens.filter(token => /^w-\d+$/.test(token))).toEqual([]);
      }
    }
  });

  it('keeps the field on the composer font-scaled height', () => {
    // ChatComposer: the input's line box times the live system font scale, plus
    // its own vertical padding and the field's 1 pt border on each side. The
    // slot must follow it or the row clips its text.
    expect(fieldBoxHeight(1)).toBe(46);
    expect(fieldBoxHeight(1.3)).toBeCloseTo(20 * 1.3 + 24 + 2);
  });
});
