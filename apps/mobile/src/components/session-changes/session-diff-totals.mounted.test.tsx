// A session diff's totals paint two signed counts. A sign is a neutral, so on a
// right-to-left screen the paragraph takes it and `+3` paints as `3+`; each
// count must be its own isolated left-to-right run while the row still mirrors.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { SessionDiffTotals } from './session-diff-totals';
import { LTR_ISOLATE_CLOSE, LTR_ISOLATE_OPEN } from '@/lib/bidi';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));

const ADDITIONS_RUN = `${LTR_ISOLATE_OPEN}+3${LTR_ISOLATE_CLOSE}`;
const DELETIONS_RUN = `${LTR_ISOLATE_OPEN}-1${LTR_ISOLATE_CLOSE}`;

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

function mountTotals(language: string, additions = 3, deletions = 1): void {
  act(() => {
    renderer = TestRenderer.create(
      createElement(SessionDiffTotals, { additions, deletions, language })
    );
  });
}

/** The host `Text` nodes, whose children are the strings the row paints. */
function hostRuns(): { className: string; text: string }[] {
  if (!renderer) {
    throw new Error('the totals did not render');
  }
  return renderer.root
    .findAll(node => Object.is(node.type, 'Text') && typeof node.props.children === 'string')
    .map(node => ({ className: String(node.props.className), text: String(node.props.children) }));
}

describe('SessionDiffTotals under a right-to-left interface', () => {
  it('keeps each signed total in its own isolated left-to-right run', () => {
    mountTotals('en');
    expect(hostRuns().map(run => run.text)).toEqual([ADDITIONS_RUN, DELETIONS_RUN]);
  });

  it('keeps a grouped total inside one run', () => {
    mountTotals('en', 1234, 12);
    expect(hostRuns().map(run => run.text)).toEqual([
      `${LTR_ISOLATE_OPEN}+1,234${LTR_ISOLATE_CLOSE}`,
      `${LTR_ISOLATE_OPEN}-12${LTR_ISOLATE_CLOSE}`,
    ]);
  });

  it('keeps both totals muted and at the small row size', () => {
    mountTotals('en');
    for (const run of hostRuns()) {
      expect(run.className).toContain('text-muted-foreground');
      expect(run.className).toContain('text-xs');
      expect(run.className).toContain('tabular-nums');
    }
  });
});
