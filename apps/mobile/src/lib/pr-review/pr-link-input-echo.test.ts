import { describe, expect, it } from 'vitest';

import {
  consumePrLinkInputEcho,
  PR_LINK_INPUT_ECHO_FIFO_CAP,
  pushPrLinkInputEcho,
} from './pr-link-input-echo';

describe('pushPrLinkInputEcho', () => {
  it('appends the programmatic value to an empty FIFO', () => {
    expect(pushPrLinkInputEcho([], 'a')).toEqual(['a']);
  });

  it('appends without dropping while under the cap', () => {
    expect(pushPrLinkInputEcho(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
  });

  it('evicts the oldest entries when the FIFO exceeds the cap', () => {
    const full = ['a', 'b', 'c', 'd'];
    expect(full).toHaveLength(PR_LINK_INPUT_ECHO_FIFO_CAP);
    expect(pushPrLinkInputEcho(full, 'e')).toEqual(['b', 'c', 'd', 'e']);
    expect(pushPrLinkInputEcho(['1', '2', '3', '4', '5'], '6', 4)).toEqual(['3', '4', '5', '6']);
  });
});

describe('consumePrLinkInputEcho', () => {
  it('treats a single paste echo as programmatic and removes it', () => {
    const result = consumePrLinkInputEcho(['pasted'], 'pasted');
    expect(result).toEqual({ kind: 'echo', pending: [] });
  });

  it('consumes both echoes from a double-paste of the same value', () => {
    let pending = pushPrLinkInputEcho([], 'same');
    pending = pushPrLinkInputEcho(pending, 'same');
    expect(pending).toEqual(['same', 'same']);

    const first = consumePrLinkInputEcho(pending, 'same');
    expect(first).toEqual({ kind: 'echo', pending: ['same'] });

    const second = consumePrLinkInputEcho(first.pending, 'same');
    expect(second).toEqual({ kind: 'echo', pending: [] });
  });

  it('consumes out-of-order echoes of two different pastes', () => {
    let pending = pushPrLinkInputEcho([], 'older');
    pending = pushPrLinkInputEcho(pending, 'newer');

    // Delayed native echo of the newer write arrives first.
    const first = consumePrLinkInputEcho(pending, 'newer');
    expect(first).toEqual({ kind: 'echo', pending: ['older'] });

    const second = consumePrLinkInputEcho(first.pending, 'older');
    expect(second).toEqual({ kind: 'echo', pending: [] });
  });

  it('classifies a real edit without draining later echoes', () => {
    const pending = pushPrLinkInputEcho([], 'pasted');

    const edit = consumePrLinkInputEcho(pending, 'user typed');
    expect(edit).toEqual({ kind: 'edit', pending: ['pasted'] });

    // Later echo of the earlier paste is still consumed (must not clobber
    // inputValueRef at the call site — covered by kind === 'echo').
    const echo = consumePrLinkInputEcho(edit.pending, 'pasted');
    expect(echo).toEqual({ kind: 'echo', pending: [] });
  });

  it('does not treat an unmatched value as an echo even when the FIFO is non-empty', () => {
    expect(consumePrLinkInputEcho(['a', 'b'], 'c')).toEqual({
      kind: 'edit',
      pending: ['a', 'b'],
    });
  });
});
