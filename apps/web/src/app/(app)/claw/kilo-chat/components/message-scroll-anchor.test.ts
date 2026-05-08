import { applyPrependScrollAnchor, capturePrependScrollAnchor } from './message-scroll-anchor';

describe('message scroll anchor', () => {
  it('captures the current scroll position before older messages are prepended', () => {
    expect(capturePrependScrollAnchor({ scrollHeight: 1200, scrollTop: 48 })).toEqual({
      scrollHeight: 1200,
      scrollTop: 48,
    });
  });

  it('preserves the visible anchor after older content increases scroll height', () => {
    const el = { scrollHeight: 1200, scrollTop: 48 };
    const snapshot = capturePrependScrollAnchor(el);

    el.scrollHeight = 1500;
    el.scrollTop = 0;
    applyPrependScrollAnchor(el, snapshot);

    expect(el.scrollTop).toBe(348);
  });
});
