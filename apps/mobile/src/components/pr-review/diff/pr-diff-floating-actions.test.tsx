// P1-F-46b: the "Finish review" affordance on the Files tab must be
// reachable regardless of pending-comment count, so a clean PR (0
// queued comments) can still be approved. The downstream submit sheet
// + `buildSubmitReviewInput` already support a clean approve; see
// `src/lib/pr-review/build-submit-review-input.test.ts` for the
// builder coverage. This file only covers the Files-tab reachability
// wiring (button present + navigates to the submit route with the
// right params).
//
// Mutation-inversion gate: temporarily re-gating on
// `pending.items.length > 0` (or removing the button entirely) must
// make the "0 pending" case below FAIL.

import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { PrDiffFloatingActions } from './pr-diff-floating-actions';
import { type PendingReviewItem } from '@/lib/pr-review/pending-review-provider';
import { type SelectionState } from '@/lib/pr-review/diff-selection';

const routerPush = vi.fn();

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock('react-native', () => ({
  View: 'View',
  Platform: { OS: 'ios' },
}));

vi.mock('@/components/ui/icons', () => ({
  MessageCirclePlus: () => null,
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    primaryForeground: '#FFFFFF',
    foreground: '#000000',
    mutedForeground: '#6F6A61',
  }),
}));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/pr-review/diff-selection-bridge', () => ({
  clearDiffSelection: vi.fn(),
}));

type PendingValue = {
  items: PendingReviewItem[];
  addComment: (item: PendingReviewItem) => void;
  updateComment: (id: string, body: string) => void;
  removeComment: (id: string) => void;
  clear: () => void;
};

let currentPending: PendingValue = {
  items: [],
  addComment: vi.fn(() => undefined),
  updateComment: vi.fn(() => undefined),
  removeComment: vi.fn(() => undefined),
  clear: vi.fn(() => undefined),
};

vi.mock('@/lib/pr-review/pending-review-provider', () => ({
  usePendingReview: () => currentPending,
}));

const baseProps = {
  owner: 'octocat',
  repo: 'hello',
  number: 7,
  viewMode: 'unified' as const,
  selection: null as SelectionState | null,
  onClearSelection: vi.fn(),
};

type FindElementArgs = {
  node: unknown;
  type: string;
  prop: string;
  value: unknown;
};

function findElement({ node, type, prop, value }: FindElementArgs): React.ReactElement | null {
  if (React.isValidElement(node)) {
    const element = node;
    const props = element.props as Record<string, unknown>;
    if (element.type === type && props[prop] === value) {
      return element;
    }
    const children = props.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        const found = findElement({ node: child, type, prop, value });
        if (found) {
          return found;
        }
      }
    } else if (children !== undefined && children !== null) {
      const found = findElement({ node: children, type, prop, value });
      if (found) {
        return found;
      }
    }
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement({ node: child, type, prop, value });
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function findSubmitButton() {
  // eslint-disable-next-line new-cap
  const element = PrDiffFloatingActions(baseProps);
  return findElement({
    node: element,
    type: 'Button',
    prop: 'accessibilityLabel',
    value: 'Finish review',
  });
}

function pressSubmit() {
  const button = findSubmitButton();
  if (!button) {
    throw new Error('Finish review button not found in rendered tree');
  }
  const onPress = (button.props as { onPress?: () => void }).onPress;
  onPress?.();
  return button;
}

function makeItem(overrides: Partial<PendingReviewItem> = {}): PendingReviewItem {
  return {
    id: 'id-1',
    path: 'src/lib.ts',
    side: 'RIGHT',
    line: 7,
    body: 'Looks good.',
    commitSha: 'head-1',
    ...overrides,
  };
}

describe('PrDiffFloatingActions submit reachability (P1-F-46b)', () => {
  function emptyPending(): PendingValue {
    return {
      items: [],
      addComment: vi.fn(() => undefined),
      updateComment: vi.fn(() => undefined),
      removeComment: vi.fn(() => undefined),
      clear: vi.fn(() => undefined),
    };
  }
  function pendingWithItems(items: PendingReviewItem[]): PendingValue {
    return {
      items,
      addComment: vi.fn(() => undefined),
      updateComment: vi.fn(() => undefined),
      removeComment: vi.fn(() => undefined),
      clear: vi.fn(() => undefined),
    };
  }

  it('renders the Finish review button when the queue is empty (clean PR)', () => {
    currentPending = emptyPending();

    const button = findSubmitButton();
    expect(button).not.toBeNull();
  });

  it('renders the Finish review button when the queue has pending items', () => {
    currentPending = pendingWithItems([makeItem(), makeItem({ id: 'id-2', path: 'src/other.ts' })]);

    const button = findSubmitButton();
    expect(button).not.toBeNull();
  });

  it('does not render a numeric count badge when the queue is empty', () => {
    currentPending = emptyPending();

    // Render the tree once to build the React element, then re-render
    // and assert no child text node renders the number "0" inside the
    // badge slot.
    pressSubmit();
    // eslint-disable-next-line new-cap
    const tree = PrDiffFloatingActions(baseProps);
    const serialized = JSON.stringify(tree);
    expect(serialized).not.toContain('"text":"0"');
  });

  it('navigates to the review-submit route with owner/repo/number on press (clean PR)', () => {
    currentPending = emptyPending();
    routerPush.mockClear();

    pressSubmit();

    expect(routerPush).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/(app)/pr-review/[owner]/[repo]/[number]/review-submit',
      params: { owner: 'octocat', repo: 'hello', number: 7 },
    });
  });

  it('navigates to the review-submit route with owner/repo/number on press (with pending)', () => {
    currentPending = pendingWithItems([makeItem()]);
    routerPush.mockClear();

    pressSubmit();

    expect(routerPush).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/(app)/pr-review/[owner]/[repo]/[number]/review-submit',
      params: { owner: 'octocat', repo: 'hello', number: 7 },
    });
  });
});
