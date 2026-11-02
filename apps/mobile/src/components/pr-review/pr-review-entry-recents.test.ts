// The recents arm of the entry-screen tests: recents must keep one row per
// provider for a same-named repository and navigate back to the row's own
// provider route. The shared plain-function-call harness (mocks, element
// lookups, the slot-array render) lives in pr-review-entry-screen-test-utils.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  find,
  findAll,
  flush,
  mocks,
  propsOf,
  render,
  renderLoaded,
  resetHookSlots,
  seedRecents,
  store,
  storedRecents,
  textValues,
} from './pr-review-entry-screen-test-utils';
import { recentPrKey } from '@/lib/pr-review/recent-prs';
import { PrReviewRecentsPending } from './pr-review-recents-pending';
import { type ConfirmDialogRequest } from '@/components/ui/dialog';

const SAME_TRIPLE = { owner: 'acme', repo: 'api', number: 7, lastOpenedAt: 1_700_000_000_000 };

beforeEach(() => {
  vi.clearAllMocks();
  resetHookSlots();
  store.clear();
});

describe('recents identity across providers', () => {
  beforeEach(() => {
    seedRecents([
      { ...SAME_TRIPLE, title: 'GitHub one' },
      {
        ...SAME_TRIPLE,
        title: 'GitLab one',
        platform: 'gitlab',
        instanceHint: 'https://gitlab.example.com',
      },
      { ...SAME_TRIPLE, title: 'Bitbucket one', platform: 'bitbucket' },
    ]);
  });

  it('renders one row per provider with a provider label', async () => {
    const tree = await renderLoaded();
    const rows = findAll(tree, 'View').filter(p => p.props?.testID === 'recent-row');
    expect(rows).toHaveLength(3);
    const labels = textValues(tree);
    expect(labels).toContain('GitHub');
    expect(labels).toContain('GitLab');
    expect(labels).toContain('Bitbucket');
    // The GitLab row writes the MR identity with the provider's own separator.
    expect(labels).toContain('acme/api!7');
    expect(labels).toContain('acme/api#7');
  });

  it("row presses navigate to the row's own provider route", async () => {
    const tree = await renderLoaded();
    const rowPressables = findAll(tree, 'View')
      .filter(row => row.props?.testID === 'recent-row')
      .map(row => find(row, 'Pressable', () => true));
    const pushes: unknown[] = [];
    for (const row of rowPressables) {
      mocks.push.mockClear();
      (propsOf(row).onPress as () => void)();
      pushes.push(mocks.push.mock.calls[0]?.[0]);
    }
    // Seed order is stored order: GitHub, GitLab, Bitbucket.
    expect(pushes).toEqual([
      '/(app)/pr-review/acme/api/7',
      '/(app)/pr-review/gitlab/acme/api/7?instance=https%3A%2F%2Fgitlab.example.com',
      '/(app)/pr-review/bitbucket/acme/api/7',
    ]);
  });

  it('long press confirms removal without opening the review and deletes only the targeted row', async () => {
    const tree = await renderLoaded();
    const rows = findAll(tree, 'View').filter(row => row.props?.testID === 'recent-row');
    const gitlab = find(rows[1], 'Pressable', () => true);
    (propsOf(gitlab).onLongPress as () => void)();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('acme/api!7') })
    );
    // The hoisted mock is untyped; the request shape is the dialog contract.
    const request = mocks.confirm.mock.calls.at(0)?.at(0) as ConfirmDialogRequest | undefined;
    request?.onConfirm();
    await flush();
    const remaining = storedRecents();
    expect(remaining).toHaveLength(2);
    expect(remaining.map(entry => recentPrKey(entry))).toEqual([
      'github||acme/api#7',
      'bitbucket||acme/api#7',
    ]);
  });

  it('the accessibility Remove action confirms removal without opening the review', async () => {
    const tree = await renderLoaded();
    const row = findAll(tree, 'View').find(candidate => candidate.props?.testID === 'recent-row');
    const github = find(row, 'Pressable', () => true);
    const action = propsOf(github).onAccessibilityAction as (event: {
      nativeEvent: { actionName: string };
    }) => void;
    action({ nativeEvent: { actionName: 'remove' } });
    expect(mocks.push).not.toHaveBeenCalled();
    const request = mocks.confirm.mock.calls.at(0)?.at(0) as ConfirmDialogRequest | undefined;
    expect(request).toBeDefined();
    request?.onConfirm();
    await flush();
    expect(storedRecents().map(entry => entry.platform)).toEqual(['gitlab', 'bitbucket']);
  });

  it('a failed row names what could not be opened in its provider vocabulary', async () => {
    store.clear();
    seedRecents([
      {
        ...SAME_TRIPLE,
        title: 'Broken MR',
        platform: 'gitlab',
        instanceHint: 'https://gl.acme.dev',
        lastResult: 'failed',
      },
      {
        ...SAME_TRIPLE,
        owner: 'kilo',
        title: 'Broken PR',
        platform: 'github',
        lastResult: 'failed',
      },
    ]);
    const tree = await renderLoaded();
    const rows = findAll(tree, 'View').filter(
      candidate => candidate.props?.testID === 'recent-row'
    );
    // Each row's own copy, read inside that row: both rows stand for a review
    // request, so a check over the whole tree would pass with the two nouns
    // swapped. The filter keeps only the failure line, never the title or ref.
    const failureCopy = (title: string) => {
      const row = rows.find(candidate =>
        findAll(candidate, 'Text').some(el => el.props?.children === title)
      );
      if (!row) {
        throw new Error(`no recents row titled ${title}`);
      }
      return textValues(row).filter(value => value.includes('request'));
    };
    expect(failureCopy('Broken MR')).toEqual(['Could not open merge request']);
    expect(failureCopy('Broken PR')).toEqual(['Could not open pull request']);
    const retry = find(tree, 'Button', p => p.accessibilityLabel === 'Retry');
    (propsOf(retry).onPress as () => void)();
    expect(mocks.push).toHaveBeenCalledWith(
      '/(app)/pr-review/gitlab/acme/api/7?instance=https%3A%2F%2Fgl.acme.dev'
    );
  });

  it('an empty recents store shows the neutral empty state', async () => {
    store.clear();
    seedRecents([]);
    const tree = await renderLoaded();
    const empty = find(tree, 'EmptyState', () => true);
    expect(empty.props?.title).toBe('No recent reviews');
    expect(empty.props?.description).toBe(
      "Paste a link above to start a review — it'll show up here next time."
    );
    // The RECENT body is the tail of the inbox scroll, so its full-size stack
    // (a 56 dp bubble over a 64 dp pin) fell under the tab bar on a compact
    // phone. It always shares the screen with the INBOX section above it, so it
    // always takes the compact form.
    expect(empty.props?.compact).toBe(true);
  });

  it('the recents load renders one row-shaped card while pending', () => {
    // getRecentPrs is still in flight on the first call: the body is a card
    // with a recent row's own shape, never a blank or a bare spinner that
    // would read as a clipped fragment and jump the section on arrival.
    store.set('pr-review-recents', JSON.stringify([{ ...SAME_TRIPLE, title: 'X' }]));
    const tree = render();
    expect(findAll(tree, PrReviewRecentsPending)).toHaveLength(1);
    // The loaded rows wait for the read: no row is drawn beside the card.
    expect(findAll(tree, 'View').filter(p => p.props?.testID === 'recent-row')).toHaveLength(0);

    // eslint-disable-next-line new-cap -- called as a plain function, like the screen harness
    const card = PrReviewRecentsPending();
    const frame = find(card, 'View', p => p.accessibilityRole === 'progressbar');
    expect(propsOf(frame).accessibilityLabel).toBe('Loading…');
    expect(findAll(frame, 'Skeleton')).toHaveLength(4);
  });
});
