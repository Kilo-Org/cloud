import { createContext, createElement, type ReactNode } from 'react';
import { act } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';
import { MenuSheet } from './menu-sheet';

type Mounted = RenderWithProvidersResult;

const sheet = vi.hoisted(() => ({ onClose: undefined as (() => void) | undefined }));

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// The real sheet presents a native window; under test it only has to hand the
// menu its dismissal, which is how Android Back reaches this component.
vi.mock('@/components/ui/sheet', () => ({
  Sheet: (props: { visible: boolean; onClose: () => void; children: ReactNode }) => {
    sheet.onClose = props.onClose;
    return createElement('Sheet', { visible: props.visible }, props.children);
  },
}));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
  TextClassContext: createContext(''),
}));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({ primary: '#0f0' }) }));

const mounted: Mounted[] = [];

afterEach(() => {
  for (const view of mounted.splice(0)) {
    act(() => {
      view.renderer.unmount();
    });
  }
});

beforeEach(() => {
  sheet.onClose = undefined;
});

function pressables(renderer: Mounted['renderer']) {
  return renderer.root.findAllByType('Pressable');
}

async function renderMenu(overrides: Partial<Parameters<typeof MenuSheet>[0]> = {}) {
  const props = {
    visible: true,
    title: 'Member E2E',
    options: [{ label: 'Change role' }, { label: 'Remove member', destructive: true }] as const,
    cancelLabel: 'Cancel',
    onSelect: vi.fn<(index: number) => void>(),
    onClose: vi.fn<() => void>(),
    ...overrides,
  };
  const view = await renderWithProviders(<MenuSheet {...props} />);
  mounted.push(view);
  return { renderer: view.renderer, props };
}

describe('MenuSheet', () => {
  it('hands the sheet its visibility so a dismissed menu can finish its animation', async () => {
    const { renderer } = await renderMenu({ visible: false });
    const [sheetNode] = renderer.root.findAllByType('Sheet');
    expect(sheetNode?.props.visible).toBe(false);
  });

  it('renders one accessible row per option plus the cancel row', async () => {
    const { renderer } = await renderMenu();
    const rows = pressables(renderer);
    expect(rows).toHaveLength(3);
    expect(rows.map(row => row.props.accessibilityLabel)).toEqual([
      'Change role',
      'Remove member',
      'Cancel',
    ]);
    expect(rows.every(row => row.props.accessibilityRole === 'button')).toBe(true);
  });

  it('marks only the destructive row as destructive', async () => {
    const { renderer } = await renderMenu();
    const labels = renderer.root.findAllByType('Text').map(node => node.props);
    const destructive = labels.filter(props =>
      String(props.className ?? '').includes('text-destructive')
    );
    expect(destructive).toHaveLength(1);
    expect(destructive[0]?.children).toBe('Remove member');
  });

  it('exposes a single-select menu as a radio group with one checked row', async () => {
    const { renderer } = await renderMenu({
      title: 'Role',
      options: [{ label: 'Owner' }, { label: 'Admin', selected: true }],
    });
    const group = renderer.root
      .findAllByType('View')
      .find(node => node.props.accessibilityRole === 'radiogroup');
    expect(group?.props.accessibilityLabel).toBe('Role');

    const rows = pressables(renderer);
    expect(rows.map(row => row.props.accessibilityRole)).toEqual(['radio', 'radio', 'button']);
    const checked = rows.map(row => {
      const state = row.props.accessibilityState as { checked?: boolean } | undefined;
      return state?.checked ?? null;
    });
    expect(checked).toEqual([false, true, null]);
    expect(renderer.root.findAllByType('Check')).toHaveLength(1);
  });

  it('keeps a plain action menu as buttons', async () => {
    const { renderer } = await renderMenu();
    expect(pressables(renderer).map(row => row.props.accessibilityRole)).toEqual([
      'button',
      'button',
      'button',
    ]);
    expect(renderer.root.findAllByType('Check')).toHaveLength(0);
  });

  it('reports the chosen row by index', async () => {
    const { renderer, props } = await renderMenu();
    await act(() => {
      const row = pressables(renderer)[1];
      if (!row) {
        throw new Error('the second menu row is missing');
      }
      (row.props.onPress as () => void)();
    });
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith(1);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('closes without a selection from the cancel row', async () => {
    const { renderer, props } = await renderMenu();
    await act(() => {
      const row = pressables(renderer)[2];
      if (!row) {
        throw new Error('the cancel row is missing');
      }
      (row.props.onPress as () => void)();
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('closes without a selection when the sheet dismisses itself', async () => {
    const { props } = await renderMenu();
    expect(sheet.onClose).toBeTypeOf('function');
    await act(() => {
      sheet.onClose?.();
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onSelect).not.toHaveBeenCalled();
  });
});
