// The header row paints a file's status and its added/removed counts. Android
// mirrors the row in a right-to-left interface, and each count is its own run
// whose leading sign is a neutral — without a left-to-right isolate the RTL
// paragraph takes the sign and `+3` paints as `3+`, so the pair reads backwards.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { FileHeaderRow } from './pr-diff-file-rows';
import { LTR_ISOLATE_CLOSE, LTR_ISOLATE_OPEN } from '@/lib/bidi';

const i18nManager = vi.hoisted(() => ({ isRTL: false }));
vi.mock('react-native', () => ({
  I18nManager: i18nManager,
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
vi.mock('@/components/ui/icons', () => ({
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  Eye: 'Eye',
  EyeOff: 'EyeOff',
  File: 'File',
  FileMinus: 'FileMinus',
  FilePlus: 'FilePlus',
  Link2: 'Link2',
}));
vi.mock('@/lib/a11y/selectable-row', () => ({
  selectableRowA11y: () => ({ accessibilityRole: 'button', accessibilityState: {} }),
}));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/lib/haptics', () => ({ selectionHaptic: vi.fn() }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#888888', info: '#0000ff', foreground: '#000000' }),
}));

const ADDITIONS_RUN = `${LTR_ISOLATE_OPEN}+3${LTR_ISOLATE_CLOSE}`;
const DELETIONS_RUN = `${LTR_ISOLATE_OPEN}-1${LTR_ISOLATE_CLOSE}`;

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  i18nManager.isRTL = false;
});

/** The host `Text` nodes, whose children are the strings the row paints. */
function hostTexts(): TestRenderer.ReactTestInstance[] {
  if (!renderer) {
    throw new Error('the row did not render');
  }
  return renderer.root.findAll(
    node => Object.is(node.type, 'Text') && typeof node.props.children === 'string'
  );
}

function mountRow(): void {
  i18nManager.isRTL = true;
  act(() => {
    renderer = TestRenderer.create(
      createElement(FileHeaderRow, {
        file: {
          path: 'src/greeting.ts',
          previousPath: null,
          status: 'modified',
          additions: 3,
          deletions: 1,
          patch: '@@ -1 +1 @@\n-export const greeting = "Hi";\n+export const greeting = "Hello";',
          patchMissing: false,
        },
        expanded: false,
        hasDiff: true,
        viewedToggle: null,
        onToggleExpand: () => undefined,
      })
    );
  });
}

describe('FileHeaderRow diff stats under an RTL interface', () => {
  it('keeps each signed count in its own isolated left-to-right run', () => {
    mountRow();
    const hosts = hostTexts();
    const additions = hosts.find(node => node.props.children === ADDITIONS_RUN);
    const deletions = hosts.find(node => node.props.children === DELETIONS_RUN);

    expect(additions).toBeDefined();
    expect(deletions).toBeDefined();
  });

  it('keeps each count muted and at the small row size', () => {
    mountRow();
    const hosts = hostTexts();
    for (const run of [ADDITIONS_RUN, DELETIONS_RUN]) {
      const host = hosts.find(node => node.props.children === run);
      expect(host?.props.className).toContain('text-muted-foreground');
      expect(host?.props.className).toContain('text-xs');
    }
  });
});
