/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as pr-diff-file-list.test.tsx) */
// Spot check e1-select-line / e1-line1-comment: the Finish review count badge
// rode the label's top-right corner (`absolute -right-2.5 -top-2.5`), so the
// opaque pill drew over the last glyphs of the label. The earlier repairs
// pinned the bar's container and footer classes, never the badge's own
// placement inside the button, so the overlap survived them. This file mounts
// the real `PrDiffFloatingActions` inside the real `Button` (the composed
// render path the e1 screenshots show: a GitLab MR, a line selected so the
// Comment row is up, a non-empty pending queue) and pins what makes the
// overlap structurally impossible: the badge is an in-flow sibling AFTER the
// label in the button's `flex-row items-center justify-center gap-2` line,
// no node in the whole tree is absolute, and a two-digit count behaves the
// same. Mutation-inversion gate: re-wrapping the label in a `relative` View
// with an `absolute` badge must fail tests 1–3.
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type * as ReactI18next from 'react-i18next';
import { type PendingReviewItem } from '@/lib/pr-review/pending-review-provider';
import { type ProviderPrRef } from '@/lib/pr-review/provider-pr-ref';
import { type SelectionState } from '@/lib/pr-review/diff-selection';
import { PrDiffFloatingActions } from './pr-diff-floating-actions';

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => {
      const i18n = actual.getI18n();
      return { t: i18n.t.bind(i18n), i18n };
    },
  };
});

const insets = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));

const pendingState = vi.hoisted((): { items: PendingReviewItem[] } => ({ items: [] }));

// The real Button and the real Text mount against these host stubs, so the
// button's own `flex-row items-center justify-center gap-2` classes — the gap
// that separates label from badge — are the ones under test.
vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  Text: 'RNText',
  Platform: { OS: 'ios' },
  I18nManager: { isRTL: false, doLeftAndRightSwapInRTL: false },
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'SlotText', View: 'SlotView' }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => insets,
}));
vi.mock('@/components/ui/icons', () => ({
  MessageCirclePlus: () => null,
}));
// The real Button reaches the UI spinner through its loading arm; the real
// spinner pulls the motion policy (expo-battery), which this harness does not
// mount. The badge placement under test never renders the spinner.
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    primaryForeground: '#FFFFFF',
    foreground: '#000000',
    mutedForeground: '#6F6A61',
  }),
}));
vi.mock('@/lib/pr-review/diff-selection-bridge', () => ({
  clearDiffSelection: vi.fn(),
}));
vi.mock('@/lib/pr-review/pending-review-provider', () => ({
  usePendingReview: () => ({
    items: pendingState.items,
    addComment: vi.fn(() => undefined),
    updateComment: vi.fn(() => undefined),
    removeComment: vi.fn(() => undefined),
    clear: vi.fn(() => undefined),
  }),
}));

const GITLAB_REF: ProviderPrRef = {
  platform: 'gitlab',
  projectPath: 'group/sub/repo',
  mrIid: 12,
};

// The e1 moment: a README line is selected, so the bar shows the selection
// row (Comment + Clear) above the Finish review button.
const SELECTION: SelectionState = {
  path: 'README.md',
  side: 'RIGHT',
  hunkKey: 'README.md:0',
  startLine: 5,
  line: 5,
  selectedText: '- old readme line',
};

function makeItem(index: number): PendingReviewItem {
  return {
    id: `id-${index}`,
    path: 'README.md',
    side: 'RIGHT',
    line: index + 1,
    body: 'comment',
    commitSha: 'head-1',
  };
}

function classesOf(node: TestRenderer.ReactTestInstance): string[] {
  return typeof node.props.className === 'string' ? node.props.className.split(' ') : [];
}

function styleOf(node: TestRenderer.ReactTestInstance): Record<string, unknown> {
  const style = node.props.style;
  return style != null && typeof style === 'object' && !Array.isArray(style)
    ? (style as Record<string, unknown>)
    : {};
}

/** The instance children of a node, dropping raw text nodes. */
function instanceChildren(node: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return node.children.filter(
    (child): child is TestRenderer.ReactTestInstance => typeof child !== 'string'
  );
}

/** Resolve a child to its rendered host node: the label mounts as the real
 * Text composite, so the button's child is the composite, not the RNText. */
function hostRoot(node: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  let current = node;
  while (typeof current.type !== 'string') {
    const [first] = instanceChildren(current);
    if (!first) {
      throw new Error('composite rendered nothing');
    }
    current = first;
  }
  return current;
}

/** The instance child at `index`, or a thrown error naming the tree. */
function childAt(
  node: TestRenderer.ReactTestInstance,
  index: number
): TestRenderer.ReactTestInstance {
  const kids = instanceChildren(node);
  const kid = kids[index];
  if (!kid) {
    throw new Error(`expected a child at index ${index}, got ${kids.length} children`);
  }
  return kid;
}

function hostText(node: TestRenderer.ReactTestInstance): string {
  return node.children.filter((child): child is string => typeof child === 'string').join('');
}

function mountBar(pendingCount: number): TestRenderer.ReactTestRenderer {
  pendingState.items = Array.from({ length: pendingCount }, (_, index) => makeItem(index));
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      <PrDiffFloatingActions
        owner="group-sub-repo"
        repo="group/sub/repo"
        number={12}
        prRef={GITLAB_REF}
        viewMode="unified"
        selection={SELECTION}
        onClearSelection={vi.fn(() => undefined)}
      />
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function finishReviewButton(
  renderer: TestRenderer.ReactTestRenderer
): TestRenderer.ReactTestInstance {
  return renderer.root.find(
    node => String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Finish review'
  );
}

describe('Finish review count badge placement (spot check e1)', () => {
  it('lays the badge out in-flow after the label, never over it', () => {
    const renderer = mountBar(3);
    const button = finishReviewButton(renderer);
    const buttonClasses = classesOf(button);
    // The button is the row that spaces label and badge apart.
    expect(buttonClasses).toContain('flex-row');
    expect(buttonClasses).toContain('items-center');
    expect(buttonClasses).toContain('justify-center');
    expect(buttonClasses).toContain('gap-2');

    const kids = instanceChildren(button);
    expect(kids).toHaveLength(2);
    const label = hostRoot(childAt(button, 0));
    expect(String(label.type)).toBe('RNText');
    expect(hostText(label)).toBe('Finish review');
    const badge = childAt(button, 1);
    expect(String(badge.type)).toBe('View');
    expect(classesOf(badge)).toContain('rounded-full');
    // The defect: the badge was anchored to the label's corner with negative
    // offsets, so it drew over the last glyphs. In-flow it cannot.
    expect(classesOf(badge)).not.toContain('absolute');
    expect(styleOf(badge).position).not.toBe('absolute');
    expect(styleOf(badge).right).toBeUndefined();
    expect(styleOf(badge).top).toBeUndefined();
    // The badge is a direct sibling of the label in the button row, after it.
    expect(badge.parent).toBe(button);
    expect(hostText(hostRoot(childAt(badge, 0)))).toBe('3');
  });

  it('renders no absolutely positioned node anywhere in the bar', () => {
    const renderer = mountBar(3);
    const absolutes = renderer.root.findAll(node => {
      if (classesOf(node).includes('absolute')) {
        return true;
      }
      return styleOf(node).position === 'absolute';
    });
    expect(absolutes).toHaveLength(0);
  });

  it('keeps the badge in-flow for a two-digit pending count', () => {
    const renderer = mountBar(12);
    const button = finishReviewButton(renderer);
    expect(instanceChildren(button)).toHaveLength(2);
    const badge = childAt(button, 1);
    expect(String(badge.type)).toBe('View');
    expect(classesOf(badge)).not.toContain('absolute');
    expect(hostText(hostRoot(childAt(badge, 0)))).toBe('12');
  });

  it('renders the label alone when the pending queue is empty', () => {
    const renderer = mountBar(0);
    const button = finishReviewButton(renderer);
    expect(instanceChildren(button)).toHaveLength(1);
    expect(hostText(hostRoot(childAt(button, 0)))).toBe('Finish review');
    const badges = renderer.root.findAll(node => classesOf(node).includes('rounded-full'));
    expect(badges).toHaveLength(0);
  });
});
