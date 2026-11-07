// The session diff list paints its added/removed totals as two sibling runs
// whose leading sign is a neutral: on a right-to-left screen the paragraph
// takes the sign and `+3` paints as `3+`. Each total must carry its own
// left-to-right isolate, while the row itself keeps mirroring.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { SessionDiffFileList } from './session-diff-file-list';
import { LTR_ISOLATE_CLOSE, LTR_ISOLATE_OPEN } from '@/lib/bidi';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@shopify/flash-list', () => ({ FlashList: 'FlashList' }));
vi.mock('@/components/pr-review/diff/diff-font-metrics', () => ({
  DiffFontMetricsContext: { Provider: 'DiffFontMetricsContext.Provider' },
  useBoundedDiffFontMetrics: () => ({
    scale: 1,
    codeFontSize: 12,
    labelFontSize: 11,
    lineHeight: 18,
    rowMinHeight: 22,
  }),
}));
vi.mock('@/components/pr-review/diff/pr-diff-file-list-render', () => ({
  useDiffRenderItem: () => vi.fn(),
}));
vi.mock('@/lib/screen-insets', () => ({
  useDetailScreenBottomPadding: () => 0,
  useSideInsetStyle: () => ({}),
}));
vi.mock('@/lib/pr-review/diff/pr-diff-list-builder', () => ({ buildFileItems: () => [] }));
vi.mock('@/lib/pr-review/diff/pr-diff-list-items', () => ({ itemTypeFor: () => 'file' }));
vi.mock('@/lib/pr-review/diff/sticky-file-headers', () => ({ stickyFileHeaderIndices: () => [] }));

const ADDITIONS_RUN = `${LTR_ISOLATE_OPEN}+3${LTR_ISOLATE_CLOSE}`;
const DELETIONS_RUN = `${LTR_ISOLATE_OPEN}-1${LTR_ISOLATE_CLOSE}`;

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

function mountList(): void {
  act(() => {
    renderer = TestRenderer.create(
      createElement(SessionDiffFileList, {
        files: [
          {
            path: 'src/greeting.ts',
            previousPath: null,
            status: 'modified',
            additions: 2,
            deletions: 1,
            patch: '@@ -1 +1 @@\n-export const greeting = "Hi";\n+export const greeting = "Hello";',
            patchMissing: false,
          },
          {
            path: 'src/index.ts',
            previousPath: null,
            status: 'modified',
            additions: 1,
            deletions: 0,
            patch: '@@ -1 +1 @@\n-export const index = 0;\n+export const index = 1;',
            patchMissing: false,
          },
        ],
      })
    );
  });
}

describe('SessionDiffFileList totals under an RTL interface', () => {
  it('keeps each signed total in its own isolated left-to-right run', () => {
    mountList();
    if (!renderer) {
      throw new Error('the list did not render');
    }
    const [totalsHeader] = renderer.root.findAll(
      node => Object.is(node.type, 'View') && node.props.testID === 'session-changes-totals'
    );
    if (!totalsHeader) {
      throw new Error('the list paints no totals header');
    }
    const hosts = totalsHeader.findAll(
      node => Object.is(node.type, 'Text') && typeof node.props.children === 'string'
    );
    const additions = hosts.find(node => node.props.children === ADDITIONS_RUN);
    const deletions = hosts.find(node => node.props.children === DELETIONS_RUN);

    expect(additions?.props.className).toContain('text-muted-foreground');
    expect(deletions?.props.className).toContain('text-muted-foreground');
  });
});
