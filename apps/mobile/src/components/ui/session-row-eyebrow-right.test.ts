import { describe, expect, it } from 'vitest';

import { selectSessionRowEyebrowRight } from './session-row-eyebrow-right';

describe('selectSessionRowEyebrowRight', () => {
  it('returns needs-input regardless of live/meta flags (highest priority)', () => {
    expect(
      selectSessionRowEyebrowRight({
        needsInput: true,
        live: true,
        hasMeta: true,
        metaWhileLive: true,
      })
    ).toEqual({ kind: 'needs-input' });
    expect(
      selectSessionRowEyebrowRight({
        needsInput: true,
        live: true,
        hasMeta: true,
        metaWhileLive: false,
      })
    ).toEqual({ kind: 'needs-input' });
    expect(
      selectSessionRowEyebrowRight({
        needsInput: true,
        live: false,
        hasMeta: false,
        metaWhileLive: false,
      })
    ).toEqual({ kind: 'needs-input' });
  });

  it('returns live-and-meta only when opted in', () => {
    expect(
      selectSessionRowEyebrowRight({
        needsInput: false,
        live: true,
        hasMeta: true,
        metaWhileLive: true,
      })
    ).toEqual({ kind: 'live-and-meta' });
  });

  it('returns live (not live-and-meta) when metaWhileLive is false even with meta and live', () => {
    // Preserves Home's byte-for-byte default behavior.
    expect(
      selectSessionRowEyebrowRight({
        needsInput: false,
        live: true,
        hasMeta: true,
        metaWhileLive: false,
      })
    ).toEqual({ kind: 'live' });
  });

  it('returns live when live is true and there is no meta', () => {
    expect(
      selectSessionRowEyebrowRight({
        needsInput: false,
        live: true,
        hasMeta: false,
        metaWhileLive: true,
      })
    ).toEqual({ kind: 'live' });
  });

  it('returns meta when not live and meta is present', () => {
    expect(
      selectSessionRowEyebrowRight({
        needsInput: false,
        live: false,
        hasMeta: true,
        metaWhileLive: false,
      })
    ).toEqual({ kind: 'meta' });
  });

  it('returns none when nothing is set', () => {
    expect(
      selectSessionRowEyebrowRight({
        needsInput: false,
        live: false,
        hasMeta: false,
        metaWhileLive: false,
      })
    ).toEqual({ kind: 'none' });
  });

  it('precedence summary: needsInput > live+meta(composition) > live > meta > none', () => {
    // needsInput beats everything
    expect(
      selectSessionRowEyebrowRight({
        needsInput: true,
        live: true,
        hasMeta: true,
        metaWhileLive: true,
      }).kind
    ).toBe('needs-input');
    // live+meta composition
    expect(
      selectSessionRowEyebrowRight({
        needsInput: false,
        live: true,
        hasMeta: true,
        metaWhileLive: true,
      }).kind
    ).toBe('live-and-meta');
    // live alone
    expect(
      selectSessionRowEyebrowRight({
        needsInput: false,
        live: true,
        hasMeta: true,
        metaWhileLive: false,
      }).kind
    ).toBe('live');
    // meta alone
    expect(
      selectSessionRowEyebrowRight({
        needsInput: false,
        live: false,
        hasMeta: true,
        metaWhileLive: false,
      }).kind
    ).toBe('meta');
    // none
    expect(
      selectSessionRowEyebrowRight({
        needsInput: false,
        live: false,
        hasMeta: false,
        metaWhileLive: false,
      }).kind
    ).toBe('none');
  });
});
