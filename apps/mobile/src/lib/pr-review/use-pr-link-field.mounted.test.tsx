import { act, createElement } from 'react';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';

import { prLinkDraft } from './pr-link-draft';
import { usePrLinkField } from './use-pr-link-field';

/**
 * The PR-link field, mounted, because what is under test is the field and the
 * value Open acts on agreeing. The field is uncontrolled: the native text, the
 * ref a submit reads, and the module draft are written by different paths, and
 * only the whole set together says what the screen shows.
 */

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  prLinkDraft.text = '';
});

async function mountField() {
  let field: ReturnType<typeof usePrLinkField> | undefined = undefined;
  function Harness() {
    field = usePrLinkField();
    return null;
  }
  const mounted = await renderWithProviders(createElement(Harness));
  onTestFinished(mounted.unmount);
  return () => {
    if (field === undefined) {
      throw new Error('the field hook did not mount');
    }
    return field;
  };
}

describe('the PR-link field', () => {
  it('opens the link the field shows after a restored draft is edited and retyped', async () => {
    const link = 'https://github.com/o/r/pull/15';
    /* A draft the screen restored on mount: the value the field was written
       with, which is also what the ref holds. */
    prLinkDraft.text = link;
    const field = await mountField();

    act(() => {
      field().restoreDraft();
    });
    act(() => {
      field().handleFieldChange('https://github.com/o/r/pull/1');
    });
    act(() => {
      field().handleFieldChange(link);
    });

    /* The field shows pull/15 again, so Open must open pull/15 — not the value
       the ref held one edit earlier. */
    expect(field().submitDecision()).toEqual({
      kind: 'open',
      ref: { platform: 'github', owner: 'o', repo: 'r', number: 15 },
    });
    expect(prLinkDraft.text).toBe(link);
  });

  it('keeps the typed link for the draft and the Open state', async () => {
    const field = await mountField();

    act(() => {
      field().handleFieldChange('https://github.com/o/r/pull/7');
    });

    expect(field().hasInput).toBe(true);
    expect(field().linkState).toBe('valid');
    expect(prLinkDraft.text).toBe('https://github.com/o/r/pull/7');
    expect(field().submitDecision()).toEqual({
      kind: 'open',
      ref: { platform: 'github', owner: 'o', repo: 'r', number: 7 },
    });
  });

  it('ignores the echo of its own write', async () => {
    const field = await mountField();

    act(() => {
      field().writeField('https://github.com/o/r/pull/3');
    });
    act(() => {
      field().handleFieldChange('https://github.com/o/r/pull/3');
    });

    expect(prLinkDraft.text).toBe('https://github.com/o/r/pull/3');
    expect(field().submitDecision()).toEqual({
      kind: 'open',
      ref: { platform: 'github', owner: 'o', repo: 'r', number: 3 },
    });
  });
});
