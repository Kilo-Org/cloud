import { describe, expect, it } from 'vitest';

import { parseHtmlImages, stripToFixedPoint } from './markdown-html-image';

describe('parseHtmlImages parser', () => {
  it('parses double-quoted attributes', () => {
    const result = parseHtmlImages('<img alt="screenshot" src="https://x/a.png">');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ src: 'https://x/a.png', alt: 'screenshot' });
  });

  it('parses single-quoted attributes', () => {
    const result = parseHtmlImages("<img alt='screenshot' src='https://x/a.png'>");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ src: 'https://x/a.png', alt: 'screenshot' });
  });

  it('width + height → aspectRatio (clamped)', () => {
    // 400/2000 = 0.2, clamped to IMAGE_PREVIEW_MIN_ASPECT_RATIO = 0.75
    const result = parseHtmlImages(
      '<img width="400" height="2000" alt="tall" src="https://x/a.png">'
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ aspectRatio: 0.75 });
  });

  it('missing width/height → undefined aspectRatio', () => {
    const result = parseHtmlImages('<img alt="a" src="https://x/b.png">');
    expect(result).toHaveLength(1);
    const image = result[0];
    if (!image) {
      throw new Error('expected image');
    }
    expect(image.aspectRatio).toBeUndefined();
  });

  it('missing alt → empty string', () => {
    const result = parseHtmlImages('<img src="https://x/c.png">');
    expect(result).toHaveLength(1);
    const image = result[0];
    if (!image) {
      throw new Error('expected image');
    }
    expect(image.alt).toBe('');
  });

  it('decodes &amp; in src', () => {
    const result = parseHtmlImages(
      '<img src="https://x/a.png?foo=bar&amp;baz=qux" alt="&amp; test">'
    );
    expect(result).toHaveLength(1);
    const image = result[0];
    if (!image) {
      throw new Error('expected image');
    }
    expect(image.src).toBe('https://x/a.png?foo=bar&baz=qux');
    expect(image.alt).toBe('& test');
  });

  it('drops relative src', () => {
    const result = parseHtmlImages('<img alt="rel" src="docs/screenshot.png">');
    expect(result).toHaveLength(0);
  });

  it('keeps data:image/png;base64,… src', () => {
    const result = parseHtmlImages('<img alt="data" src="data:image/png;base64,iVBORw0KGgo=">');
    expect(result).toHaveLength(1);
    const image = result[0];
    if (!image) {
      throw new Error('expected image');
    }
    expect(image.src).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  it('no <img> → empty array', () => {
    expect(parseHtmlImages('<p>hello</p>')).toStrictEqual([]);
  });

  it('two <img> in one string → two entries', () => {
    const result = parseHtmlImages(
      '<img alt="a" src="https://x/a.png"><img alt="b" src="https://x/b.png">'
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ src: 'https://x/a.png', alt: 'a' });
    expect(result[1]).toMatchObject({ src: 'https://x/b.png', alt: 'b' });
  });

  it('parses self-closing <img … />', () => {
    const result = parseHtmlImages('<img alt="a" src="https://x/a.png" />');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ src: 'https://x/a.png' });
  });

  it('parses uppercase <IMG …>', () => {
    const result = parseHtmlImages('<IMG SRC="https://x/a.png" alt="A">');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ src: 'https://x/a.png', alt: 'A' });
  });

  it('<p align="center"><img …></p> → one entry (tags-only leftover)', () => {
    const result = parseHtmlImages('<p align="center"><img alt="a" src="https://x/a.png"></p>');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ src: 'https://x/a.png' });
  });

  it('<p>caption <img …></p> → empty array (text would be lost)', () => {
    const result = parseHtmlImages('<p>caption <img alt="a" src="https://x/a.png"></p>');
    expect(result).toStrictEqual([]);
  });

  it('comment-only token → empty array (commented out)', () => {
    const result = parseHtmlImages('<!-- <img src="https://x/a.png"> -->');
    expect(result).toStrictEqual([]);
  });

  it('comment followed by live <img> → one entry (comment strip does not eat tag)', () => {
    const result = parseHtmlImages('<!-- note --><img src="https://x/a.png">');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ src: 'https://x/a.png' });
  });

  it('decodes &#39; &lt; &gt; in alt text', () => {
    const result = parseHtmlImages('<img alt="it&#39;s &lt;cool&gt;" src="https://x/a.png">');
    expect(result).toHaveLength(1);
    const image = result[0];
    if (!image) {
      throw new Error('expected image');
    }
    expect(image.alt).toBe("it's <cool>");
  });

  it('decodes &quot; in alt text', () => {
    const result = parseHtmlImages('<img alt="say &quot;hello&quot;" src="https://x/a.png">');
    expect(result).toHaveLength(1);
    const image = result[0];
    if (!image) {
      throw new Error('expected image');
    }
    expect(image.alt).toBe('say "hello"');
  });

  it('prefers real src over data-canonical-src (either order)', () => {
    for (const html of [
      '<img data-canonical-src="https://decoy/a.png" src="https://real/b.png">',
      '<img src="https://real/b.png" data-canonical-src="https://decoy/a.png">',
    ]) {
      const result = parseHtmlImages(html);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ src: 'https://real/b.png' });
    }
  });

  it('prefers real alt over data-alt', () => {
    const result = parseHtmlImages('<img data-alt="decoy" alt="real" src="https://x/a.png">');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ alt: 'real' });
  });

  it('prefers real width/height over data-width/data-height', () => {
    const result = parseHtmlImages(
      '<img data-width="1" data-height="1" width="400" height="200" src="https://x/a.png">'
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ aspectRatio: 2 });
  });

  it('data-src only (no real src) → empty array', () => {
    expect(parseHtmlImages('<img data-src="https://x/a.png">')).toStrictEqual([]);
  });

  it('stripToFixedPoint clears a boundary-joined residual comment (single pass cannot)', () => {
    // A single global pass leaves the complete comment `<!-- -->`; the loop clears it.
    expect(stripToFixedPoint('<<!-- -->!-- -->', /<!--[\s\S]*?-->/g)).toBe('');
  });

  it('stripToFixedPoint is a no-op on input without comments', () => {
    expect(stripToFixedPoint('<img src="https://x/a.png">', /<!--[\s\S]*?-->/g)).toBe(
      '<img src="https://x/a.png">'
    );
  });

  // Behavior locks for adversarial comment input: these pass before and after the
  // fix and pin the parser's contract on nested-comment tricks.
  it('nested-comment trick stays comment-only → empty array', () => {
    expect(parseHtmlImages('<!<!-- -->-->')).toStrictEqual([]);
  });

  it('nested-comment prefix does not hide a following <img>', () => {
    const result = parseHtmlImages('<!<!-- -->--><img src="https://x/a.png">');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ src: 'https://x/a.png' });
  });
});
