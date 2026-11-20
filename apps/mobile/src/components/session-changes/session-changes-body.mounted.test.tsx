// The read-only session diff paints a full-bleed notice bar above the file
// list. On a landscape phone the body must sit inside the side safe area: the
// wrapper takes the inset, the bar keeps its own `px-4` page gutter inside it,
// and the two add up instead of the bar's inline padding swallowing the gutter.

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

/** The notice bar's own node, its `px-4` gutter and the wrapper above it. */
function noticeNodes(root: TestRenderer.ReactTestInstance) {
  const [paragraph] = root.findAll(
    node => String(node.type) === 'Text' && node.props.testID === 'session-changes-read-only'
  );
  if (!paragraph) {
    throw new Error('Read-only notice is missing');
  }
  const bar = paragraph.parent;
  const wrapper = bar?.parent;
  if (!bar || !wrapper) {
    throw new Error('Read-only notice has no bar and wrapper');
  }
  return { bar, wrapper };
}

it('clears the landscape side insets on a wrapper above the notice gutter', () => {
  state.insets.left = 47;
  const { bar, wrapper } = noticeNodes(mountBody().root);

  // The 8 dp on the other side is the shared helper's corner clearance for a
  // side status area that leaves the top inset at zero.
  expect(wrapper.props.style).toEqual({ paddingLeft: 47, paddingRight: 8 });
  // The bar keeps the page gutter the inset adds to.
  expect(bar.props.className).toContain('px-4');
});

it('leaves the notice bar without an inset wrapper in portrait', () => {
  const { bar, wrapper } = noticeNodes(mountBody().root);

  expect(wrapper.props.style).toBeUndefined();
  expect(bar.props.className).toContain('px-4');
});
