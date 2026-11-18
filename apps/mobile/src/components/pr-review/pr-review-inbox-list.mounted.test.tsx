// Layout contracts for the PR-review inbox list: the landscape side insets on
// the list container, and the row's meta line keeping the provider chip whole
// beside the flexing ref · age text.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  flashListProps,
  inboxChips,
  inboxState,
  insetsState,
  makeItem,
  metadataText,
  mountInboxList,
} from './pr-review-inbox-list.test-helpers';

describe('PrReviewInboxList side insets (landscape)', () => {
  beforeEach(() => {
    insetsState.top = 0;
    insetsState.bottom = 0;
    insetsState.left = 0;
    insetsState.right = 0;
    inboxState.query.isPending = false;
    inboxState.query.isFetching = false;
    inboxState.query.hasNextPage = false;
    inboxState.query.isFetchingNextPage = false;
    inboxState.items = [makeItem()];
    inboxState.firstPageErrorState = null;
    inboxState.laterPageError = false;
  });

  it('carries zero side paddings at zero portrait insets and renders rows', () => {
    const renderer = mountInboxList();

    expect(flashListProps(renderer).contentContainerStyle).toEqual({
      paddingLeft: 0,
      paddingRight: 0,
    });
    // Populated view renders inside the padded container.
    expect(
      renderer.root.findAll(
        node =>
          String(node.type) === 'Pressable' &&
          node.props.accessibilityLabel === 'octocat/hello-world#7'
      )
    ).toHaveLength(1);
  });

  it('clears the sensor housing with the landscape side insets', () => {
    insetsState.left = 47;
    insetsState.right = 59;
    const renderer = mountInboxList();

    expect(flashListProps(renderer).contentContainerStyle).toEqual({
      paddingLeft: 47,
      paddingRight: 59,
    });
    expect(
      renderer.root.findAll(
        node =>
          String(node.type) === 'Pressable' &&
          node.props.accessibilityLabel === 'octocat/hello-world#7'
      )
    ).toHaveLength(1);
  });
});

// The row's meta line is a flex row: the ref · age text and the provider chip.
// A long ref (a nested GitLab project path, or `Kilo-Org/cloud#6401` at 12px on
// a 360dp screen) made the row overflow, so the chip ran past the px-6 right
// edge and its rounded end was clipped by the screen. The text is the flexible
// value, so it ellipsizes and the chip keeps its full rounded width inside the
// row — the same fix as `PrRefsRow` in pr-review-overview-parts.tsx.
describe('InboxRow meta line (a long ref keeps the chip inside the row)', () => {
  beforeEach(() => {
    Object.assign(insetsState, { top: 0, bottom: 0, left: 0, right: 0 });
    inboxState.query.isPending = false;
    inboxState.query.isFetching = false;
    inboxState.query.hasNextPage = false;
    inboxState.query.isFetchingNextPage = false;
    inboxState.items = [
      makeItem({ owner: 'Kilo-Org', repo: 'cloud', number: 6401, title: 'chore(kilo-app): bump' }),
    ];
    inboxState.firstPageErrorState = null;
    inboxState.laterPageError = false;
  });

  it('shrinks the ref · age text and holds the provider chip at full width', () => {
    const renderer = mountInboxList();

    // The ref · age text is the row's only single-line muted Text.
    const metaText = renderer.root.find(
      node =>
        String(node.type) === 'Text' &&
        node.props.variant === 'muted' &&
        node.props.numberOfLines === 1
    );
    const metaClassName = String(metaText.props.className);
    expect(metaClassName).toContain('min-w-0');
    expect(metaClassName).toContain('shrink');

    // The provider chip keeps its own width so its rounded-full pill stays
    // intact rather than being squeezed by the flexible text; a draft chip
    // beside it holds the same width.
    inboxState.items = [
      makeItem({ owner: 'Kilo-Org', repo: 'cloud', number: 6401, isDraft: true }),
    ];
    const draftRenderer = mountInboxList();
    const chips = inboxChips(draftRenderer);
    expect(chips).toHaveLength(2);
    for (const chip of chips) {
      expect(String(chip.props.className)).toContain('shrink-0');
    }

    renderer.unmount();
    draftRenderer.unmount();
  });
});

// The explorer found the `Conversation-only fixture` row pushing its provider
// chip off the right edge ("Pull re") because the long repo/time metadata kept
// its intrinsic width. The row must give that metadata up (single line, shrink)
// and hold the chips whole (shrink-0).
describe('InboxRow metadata line', () => {
  beforeEach(() => {
    insetsState.left = 0;
    insetsState.right = 0;
    inboxState.query.isPending = false;
    inboxState.firstPageErrorState = null;
    inboxState.firstPageErrorPlatform = null;
    inboxState.organizationId = null;
    inboxState.laterPageError = false;
    inboxState.items = [
      makeItem({ owner: 'kilo-stub', repo: 'discussion-conversation-only', number: 2 }),
    ];
  });

  it('truncates the metadata and holds the chip whole beside it', () => {
    const renderer = mountInboxList();
    const rowChips = inboxChips(renderer);

    const meta = metadataText(renderer);
    expect(meta.props.numberOfLines).toBe(1);
    expect(String(meta.props.className)).toContain('shrink');
    expect(String(meta.props.className)).toContain('min-w-0');
    expect(rowChips).toHaveLength(1);
    expect(rowChips[0]?.props.className).toContain('shrink-0');
    expect(
      renderer.root.findAll(
        node => String(node.type) === 'Text' && node.props.children === 'prReview.terms.pullRequest'
      )
    ).toHaveLength(1);
  });
});
