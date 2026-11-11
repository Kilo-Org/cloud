import { describe, expect, it } from 'vitest';

import { resolveTranscriptFrame } from './session-message-list-anchor';

describe('resolveTranscriptFrame', () => {
  it('fills the region exactly when the chrome has not grown', () => {
    expect(resolveTranscriptFrame(0)).toEqual({ holder: { flex: 1 }, content: { flex: 1 } });
  });

  it('reuses the shared fill so an unchanging frame keeps its identity', () => {
    expect(resolveTranscriptFrame(0).content).toBe(resolveTranscriptFrame(0).holder);
  });

  it('keeps the transcript height and rides it up by the growth', () => {
    const frame = resolveTranscriptFrame(64);
    // `top` and `bottom` together give the content the holder's previous
    // height, which is what keeps the list's viewport, content height, scroll
    // offset and at-bottom verdict describing the same rows: no scroll needed.
    expect(frame.content).toEqual({
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      top: -64,
    });
    expect(frame.holder).toEqual({ flex: 1, overflow: 'hidden' });
  });

  it('treats a non-finite or shrinking chrome as no growth', () => {
    expect(resolveTranscriptFrame(Number.NaN).holder).toEqual({ flex: 1 });
    expect(resolveTranscriptFrame(-20).holder).toEqual({ flex: 1 });
  });
});
