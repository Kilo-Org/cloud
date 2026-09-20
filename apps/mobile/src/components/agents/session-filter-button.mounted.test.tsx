import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { SessionFilterButton } from './session-filter-button';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/icons', () => ({
  SlidersHorizontal: 'SlidersHorizontal',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#111111', mutedForeground: '#666666' }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
// The real `@/components/ui/text` loads `@rn-primitives/slot`, whose node_modules
// `.mjs` contains JSX that this pipeline cannot transform. The badge only needs
// the host name; the plain-icon case renders no text at all.
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return { Text: 'Text', TextClassContext: React.createContext<string | undefined>(undefined) };
});

// The explorer files a hit when both sides of a focusable control are under
// 28dp, and DESIGN.md keeps touch surfaces at a 44pt target even when the
// visual control is compact. The icon alone was 20dp, so the button now paints
// an exact 30pt box (Tailwind's rem-scaled h-7 only measured ~24.5pt on device)
// and reaches 44pt through its hit slop.
const VISIBLE_SIZE_DP = 30;
const MIN_TARGET_DP = 44;
// `gap-4` is 4 × `--spacing` = 1rem, and react-native-css sets 1rem = 14pt on
// native (react-native-css `dist/module/native-internal/root.js`). A sibling
// control shares the gap, so one side's slop can use at most half of it.
const HALF_HEADER_GAP_DP = 7;

type HitSlop = { top: number; bottom: number; left: number; right: number };

async function renderButton(activeCount: number) {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(
      createElement(SessionFilterButton, {
        activeCount,
        onPress: () => undefined,
        testID: 'agents-open-filters',
      })
    );
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function findFilterButton(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  return root.find(node => String(node.type) === 'Pressable');
}

describe('SessionFilterButton mounted', () => {
  it('paints the icon in a 30pt box, over the small-control bar', async () => {
    const renderer = await renderButton(0);

    const node = findFilterButton(renderer.root);
    expect(String(node.props.className)).toContain(`h-[${VISIBLE_SIZE_DP}px]`);
    expect(String(node.props.className)).toContain(`w-[${VISIBLE_SIZE_DP}px]`);

    renderer.unmount();
  });

  it('lifts the 30pt box to the 44pt minimum touch target on both axes', async () => {
    const renderer = await renderButton(0);

    const node = findFilterButton(renderer.root);
    const hitSlop = node.props.hitSlop as HitSlop;
    expect(VISIBLE_SIZE_DP + hitSlop.top + hitSlop.bottom).toBeGreaterThanOrEqual(MIN_TARGET_DP);
    expect(VISIBLE_SIZE_DP + hitSlop.left + hitSlop.right).toBeGreaterThanOrEqual(MIN_TARGET_DP);

    renderer.unmount();
  });

  it('keeps each horizontal slop inside half the 14pt header gap, either direction', async () => {
    const renderer = await renderButton(0);

    const node = findFilterButton(renderer.root);
    const hitSlop = node.props.hitSlop as HitSlop;
    // The sibling control shares the `gap-4` gap and the layout direction
    // decides which physical side faces it, so neither horizontal slop may
    // exceed half the gap.
    expect(hitSlop.left).toBeLessThanOrEqual(HALF_HEADER_GAP_DP);
    expect(hitSlop.right).toBeLessThanOrEqual(HALF_HEADER_GAP_DP);

    renderer.unmount();
  });

  it('keeps the applied-filter count on the enlarged box', async () => {
    const renderer = await renderButton(3);

    const badge = renderer.root.find(node => node.props.testID === 'session-filter-badge');
    expect(badge.children).toEqual(['3']);

    renderer.unmount();
  });
});
