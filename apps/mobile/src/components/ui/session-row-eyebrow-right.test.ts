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
    ).toEqual({ kind: 'needs-input', showPlatformIcon: false });
    expect(
      selectSessionRowEyebrowRight({
        needsInput: true,
        live: true,
        hasMeta: true,
        metaWhileLive: false,
      })
    ).toEqual({ kind: 'needs-input', showPlatformIcon: false });
    expect(
      selectSessionRowEyebrowRight({
        needsInput: true,
        live: false,
        hasMeta: false,
        metaWhileLive: false,
      })
    ).toEqual({ kind: 'needs-input', showPlatformIcon: false });
  });

  it('returns live-and-meta only when opted in', () => {
    expect(
      selectSessionRowEyebrowRight({
        needsInput: false,
        live: true,
        hasMeta: true,
        metaWhileLive: true,
      })
    ).toEqual({ kind: 'live-and-meta', showPlatformIcon: false });
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
    ).toEqual({ kind: 'live', showPlatformIcon: false });
  });

  it('returns live when live is true and there is no meta', () => {
    expect(
      selectSessionRowEyebrowRight({
        needsInput: false,
        live: true,
        hasMeta: false,
        metaWhileLive: true,
      })
    ).toEqual({ kind: 'live', showPlatformIcon: false });
  });

  it('returns meta when not live and meta is present', () => {
    expect(
      selectSessionRowEyebrowRight({
        needsInput: false,
        live: false,
        hasMeta: true,
        metaWhileLive: false,
      })
    ).toEqual({ kind: 'meta', showPlatformIcon: false });
  });

  it('returns none when nothing is set', () => {
    expect(
      selectSessionRowEyebrowRight({
        needsInput: false,
        live: false,
        hasMeta: false,
        metaWhileLive: false,
      })
    ).toEqual({ kind: 'none', showPlatformIcon: false });
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

  describe('showPlatformIcon', () => {
    it('needs-input suppresses the icon even when hasPlatformIcon is true', () => {
      expect(
        selectSessionRowEyebrowRight({
          needsInput: true,
          live: true,
          hasMeta: true,
          metaWhileLive: true,
          hasPlatformIcon: true,
        })
      ).toEqual({ kind: 'needs-input', showPlatformIcon: false });
    });

    it('live-and-meta shows the icon iff hasPlatformIcon', () => {
      expect(
        selectSessionRowEyebrowRight({
          needsInput: false,
          live: true,
          hasMeta: true,
          metaWhileLive: true,
          hasPlatformIcon: true,
        })
      ).toEqual({ kind: 'live-and-meta', showPlatformIcon: true });
      expect(
        selectSessionRowEyebrowRight({
          needsInput: false,
          live: true,
          hasMeta: true,
          metaWhileLive: true,
          hasPlatformIcon: false,
        })
      ).toEqual({ kind: 'live-and-meta', showPlatformIcon: false });
    });

    it('live shows the icon iff hasPlatformIcon', () => {
      expect(
        selectSessionRowEyebrowRight({
          needsInput: false,
          live: true,
          hasMeta: false,
          metaWhileLive: false,
          hasPlatformIcon: true,
        })
      ).toEqual({ kind: 'live', showPlatformIcon: true });
      expect(
        selectSessionRowEyebrowRight({
          needsInput: false,
          live: true,
          hasMeta: false,
          metaWhileLive: false,
        })
      ).toEqual({ kind: 'live', showPlatformIcon: false });
    });

    it('meta shows the icon iff hasPlatformIcon', () => {
      expect(
        selectSessionRowEyebrowRight({
          needsInput: false,
          live: false,
          hasMeta: true,
          metaWhileLive: false,
          hasPlatformIcon: true,
        })
      ).toEqual({ kind: 'meta', showPlatformIcon: true });
      expect(
        selectSessionRowEyebrowRight({
          needsInput: false,
          live: false,
          hasMeta: true,
          metaWhileLive: false,
          hasPlatformIcon: false,
        })
      ).toEqual({ kind: 'meta', showPlatformIcon: false });
    });

    it('none shows the icon iff hasPlatformIcon', () => {
      expect(
        selectSessionRowEyebrowRight({
          needsInput: false,
          live: false,
          hasMeta: false,
          metaWhileLive: false,
          hasPlatformIcon: true,
        })
      ).toEqual({ kind: 'none', showPlatformIcon: true });
      expect(
        selectSessionRowEyebrowRight({
          needsInput: false,
          live: false,
          hasMeta: false,
          metaWhileLive: false,
        })
      ).toEqual({ kind: 'none', showPlatformIcon: false });
    });

    it('undefined hasPlatformIcon is treated as false for all kinds', () => {
      // Behaviorally identical to today when no icon is provided.
      const base = {
        needsInput: false as const,
        live: false as const,
        hasMeta: true as const,
        metaWhileLive: false as const,
      };
      expect(selectSessionRowEyebrowRight(base)).toEqual({
        kind: 'meta',
        showPlatformIcon: false,
      });
      expect(selectSessionRowEyebrowRight({ ...base, hasPlatformIcon: undefined })).toEqual({
        kind: 'meta',
        showPlatformIcon: false,
      });
    });
  });
});
