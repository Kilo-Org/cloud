// The read-only session diff paints a full-bleed notice band above the file
// list. On a landscape phone the body must sit inside the side safe area
// without the band losing its fill: the band keeps `bg-secondary` and the
// hairline and takes the inset as padding, and the bar inside it keeps its own
// `px-4` page gutter, so the two add up instead of the band's inline padding
// swallowing the gutter.

import { type ComponentProps, createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import '@/i18n';
import { SessionChangesBody } from './session-changes-body';

const state = vi.hoisted(() => ({ insets: { left: 0, right: 0 } }));

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false, doLeftAndRightSwapInRTL: true },
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({
    top: 0,
    bottom: 0,
    left: state.insets.left,
    right: state.insets.right,
  }),
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/pr-review/diff/pr-diff-file-list-loading', () => ({
  PrDiffFileListLoading: 'PrDiffFileListLoading',
}));
vi.mock('@/components/session-changes/session-changes-file-list', () => ({
  SessionChangesFileList: 'SessionChangesFileList',
}));
vi.mock('@/components/session-changes/session-changes-file-view', () => ({
  SessionChangesFileView: 'SessionChangesFileView',
}));
vi.mock('@/components/session-changes/session-diff-file-list', () => ({
  SessionDiffFileList: 'SessionDiffFileList',
}));
vi.mock('@/components/ui/icons', () => ({ FileDiff: 'FileDiff' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

const READ_ONLY_FILE = {
  path: 'src/app.ts',
  previousPath: null,
  status: 'modified',
  additions: 3,
  deletions: 1,
  patch: null,
  patchMissing: true,
};

/** The body's read-only session diff: one saved file, no Cloud Agent capture. */
function readOnlyProps(): ComponentProps<typeof SessionChangesBody> {
  const noop = () => {
    // The suite never taps through the body.
  };
  return {
    sessionPending: false,
    sessionFailed: false,
    onRetrySession: noop,
    readOnly: true,
    legacyFiles: [READ_ONLY_FILE],
    legacyTooLarge: false,
    legacyPending: false,
    legacyFailed: false,
    onRetryLegacy: noop,
    changesPending: false,
    changesFailed: false,
    onRetryChanges: noop,
    files: [],
    truncated: false,
    refreshing: false,
    onRefresh: noop,
    openFile: null,
    onOpenFile: noop,
    patchState: null,
    filePending: false,
    fileFailed: false,
    commentsForFile: [],
    commentsDisabledReason: undefined,
    onTapLine: noop,
    onRetryFile: noop,
  };
}

beforeEach(() => {
  state.insets.left = 0;
  state.insets.right = 0;
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

function mountBody(): TestRenderer.ReactTestRenderer {
  act(() => {
    renderer = TestRenderer.create(createElement(SessionChangesBody, readOnlyProps()));
  });
  const mounted = renderer;
  if (!mounted) {
    throw new Error('Session changes body did not mount');
  }
  return mounted;
}

/** The notice paragraph, the padded bar around it, and the full-bleed band above. */
function noticeNodes(root: TestRenderer.ReactTestInstance) {
  const [paragraph] = root.findAll(
    node => String(node.type) === 'Text' && node.props.testID === 'session-changes-read-only'
  );
  if (!paragraph) {
    throw new Error('Read-only notice is missing');
  }
  const bar = paragraph.parent;
  const band = bar?.parent;
  if (!bar || !band) {
    throw new Error('Read-only notice has no bar and band');
  }
  return { bar, band };
}

it('clears the landscape side insets under a full-bleed notice band', () => {
  state.insets.left = 47;
  const { bar, band } = noticeNodes(mountBody().root);

  // The 8 dp on the other side is the shared helper's corner clearance for a
  // side status area that leaves the top inset at zero.
  expect(band.props.style).toEqual({ paddingLeft: 47, paddingRight: 8 });
  // The fill and divider stay on the element that takes the inset, so the band
  // still spans the window and the strip beside the cutout keeps its color.
  expect(band.props.className).toContain('bg-secondary');
  expect(band.props.className).toContain('border-b');
  expect(band.props.className).toContain('border-hair-soft');
  // The bar keeps the page gutter, so the text clears the cutout by 47 + 14.
  expect(bar.props.className).toContain('px-4');
});

it('leaves the notice band without an inset in portrait', () => {
  const { bar, band } = noticeNodes(mountBody().root);

  expect(band.props.style).toBeUndefined();
  expect(band.props.className).toContain('bg-secondary');
  expect(bar.props.className).toContain('px-4');
});
