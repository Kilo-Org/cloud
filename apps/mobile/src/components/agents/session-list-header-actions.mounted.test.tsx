import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { SessionListHeaderActions } from './session-list-header-actions';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/icons', () => ({
  Plus: 'Plus',
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

// Both header controls own an exact 30pt visible box (Tailwind's rem-scaled h-7
// only measured ~24.5pt on device) and reach the 44pt target through slop; the
// explorer files an icon-only control whose node is under 28dp.
const VISIBLE_SIZE_DP = 30;
const MIN_TARGET_DP = 44;

type HitSlop = { top: number; bottom: number; left: number; right: number };

async function renderActions(showNewSession: boolean) {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(
      createElement(SessionListHeaderActions, {
        activeFilterCount: 0,
        showNewSession,
        onNewSession: () => undefined,
        onOpenFilters: () => undefined,
      })
    );
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function findControls(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => String(node.type) === 'Pressable');
}

describe('SessionListHeaderActions mounted', () => {
  it('paints both header controls in a 30pt box that reaches the 44pt target', async () => {
    const renderer = await renderActions(true);

    const controls = findControls(renderer.root);
    expect(controls).toHaveLength(2);
    for (const node of controls) {
      expect(String(node.props.className)).toContain(`h-[${VISIBLE_SIZE_DP}px]`);
      expect(String(node.props.className)).toContain(`w-[${VISIBLE_SIZE_DP}px]`);
      const hitSlop = node.props.hitSlop as HitSlop;
      expect(VISIBLE_SIZE_DP + hitSlop.top + hitSlop.bottom).toBeGreaterThanOrEqual(MIN_TARGET_DP);
      expect(VISIBLE_SIZE_DP + hitSlop.left + hitSlop.right).toBeGreaterThanOrEqual(MIN_TARGET_DP);
    }

    renderer.unmount();
  });

  it('drops the new-session control while the empty state owns creation', async () => {
    const renderer = await renderActions(false);

    expect(findControls(renderer.root)).toHaveLength(1);

    renderer.unmount();
  });
});
