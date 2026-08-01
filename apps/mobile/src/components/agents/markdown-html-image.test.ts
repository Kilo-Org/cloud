import { describe, expect, it } from 'vitest';

import { parseHtmlImages } from './markdown-html-image';

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
    expect(result[0]!.aspectRatio).toBeUndefined();
  });

  it('missing alt → empty string', () => {
    const result = parseHtmlImages('<img src="https://x/c.png">');
    expect(result).toHaveLength(1);
    expect(result[0]!.alt).toBe('');
  });

  it('decodes &amp; in src', () => {
    const result = parseHtmlImages(
      '<img src="https://x/a.png?foo=bar&amp;baz=qux" alt="&amp; test">'
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.src).toBe('https://x/a.png?foo=bar&baz=qux');
    expect(result[0]!.alt).toBe('& test');
  });

  it('drops relative src', () => {
    const result = parseHtmlImages('<img alt="rel" src="docs/screenshot.png">');
    expect(result).toHaveLength(0);
  });

  it('keeps data:image/png;base64,… src', () => {
    const result = parseHtmlImages('<img alt="data" src="data:image/png;base64,iVBORw0KGgo=">');
    expect(result).toHaveLength(1);
    expect(result[0]!.src).toBe('data:image/png;base64,iVBORw0KGgo=');
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
    expect(result[0]!.alt).toBe("it's <cool>");
  });

  it('decodes &quot; in alt text', () => {
    const result = parseHtmlImages('<img alt="say &quot;hello&quot;" src="https://x/a.png">');
    expect(result).toHaveLength(1);
    expect(result[0]!.alt).toBe('say "hello"');
  });
});
