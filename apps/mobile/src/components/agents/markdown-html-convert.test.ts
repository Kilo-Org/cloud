import { describe, expect, it } from 'vitest';

import { convertHtmlToMarkdown } from './markdown-html-convert';

describe('convertHtmlToMarkdown inline tags', () => {
  it.each([
    ['<b>bold</b>', '**bold**'],
    ['<strong>bold</strong>', '**bold**'],
    ['<i>italic</i>', '*italic*'],
    ['<em>italic</em>', '*italic*'],
    ['<s>gone</s>', '~~gone~~'],
    ['<del>gone</del>', '~~gone~~'],
    ['<strike>gone</strike>', '~~gone~~'],
    ['<code>run()</code>', '`run()`'],
    ['Say <B>hi</B> now', 'Say **hi** now'],
  ])('converts %s', (html, markdown) => {
    expect(convertHtmlToMarkdown(html)).toBe(markdown);
  });

  it('nests inline tags', () => {
    expect(convertHtmlToMarkdown('<b>bold <i>and italic</i></b> and <i><s>both</s></i>')).toBe(
      '**bold *and italic*** and *~~both~~*'
    );
  });

  it('moves edge whitespace outside the delimiters and collapses inner whitespace', () => {
    expect(convertHtmlToMarkdown('a<b> spaced\n  out </b>b')).toBe('a **spaced out** b');
    expect(convertHtmlToMarkdown('a<b> </b>b')).toBe('a b');
  });

  it('keeps emphasis HTML that markdown would not parse back as emphasis', () => {
    // `**"x"**y`: a closing run after punctuation needs space or punctuation next.
    expect(convertHtmlToMarkdown('<b>"x"</b>y')).toBe('<b>"x"</b>y');
  });

  it('escapes backticks inside code', () => {
    expect(convertHtmlToMarkdown('<code>a`b</code>')).toBe('``a`b``');
    expect(convertHtmlToMarkdown('<code>`tick`</code>')).toBe('`` `tick` ``');
    expect(convertHtmlToMarkdown('<code>&lt;div&gt; &amp;</code>')).toBe('`<div> &`');
  });

  it('keeps code with markup or an unknown entity as HTML', () => {
    expect(convertHtmlToMarkdown('<code><b>x</b></code>')).toBe('<code><b>x</b></code>');
    expect(convertHtmlToMarkdown('<code>&hellip;</code>')).toBe('<code>&hellip;</code>');
  });

  it('converts links with their title and wraps destinations with spaces', () => {
    expect(convertHtmlToMarkdown('<a href="https://example.com">Docs</a>')).toBe(
      '[Docs](https://example.com)'
    );
    expect(
      convertHtmlToMarkdown(
        '<a href="https://example.com/a b" title="Say &quot;hi&quot;" target="_blank">x</a>'
      )
    ).toBe('[x](<https://example.com/a b> "Say &quot;hi&quot;")');
    expect(convertHtmlToMarkdown('<a href="https://x.dev"><b>bold</b> <code>c</code></a>')).toBe(
      '[**bold** `c`](https://x.dev)'
    );
  });

  it('keeps anchors without a usable destination as HTML', () => {
    expect(convertHtmlToMarkdown('<a name="top">x</a>')).toBe('<a name="top">x</a>');
    expect(convertHtmlToMarkdown('<a href="https://x.dev" class="c">x</a>')).toBe(
      '<a href="https://x.dev" class="c">x</a>'
    );
    expect(convertHtmlToMarkdown('<a href="https://x.dev">a]b</a>')).toBe(
      '<a href="https://x.dev">a]b</a>'
    );
  });

  it('converts HTTPS images to markdown images, which the image gate then handles', () => {
    expect(convertHtmlToMarkdown('<img src="https://tracker.example/p.png" alt="a [shot]">')).toBe(
      String.raw`![a \[shot\]](https://tracker.example/p.png)`
    );
    expect(
      convertHtmlToMarkdown('<a href="https://x.dev"><img src="https://x.dev/a.png" alt="i"></a>')
    ).toBe('[![i](https://x.dev/a.png)](https://x.dev)');
  });

  it('keeps images markdown cannot express the same way as HTML', () => {
    for (const html of [
      '<img src="http://x.dev/a.png">',
      '<img src="data:image/png;base64,AAAA">',
      '<img src="https://x.dev/a.png" width="40" height="20">',
    ]) {
      expect(convertHtmlToMarkdown(html)).toBe(html);
    }
  });

  it('turns a line break into a backslash break that continues the paragraph', () => {
    expect(convertHtmlToMarkdown('one<br>two')).toBe('one\\\ntwo');
    expect(convertHtmlToMarkdown('one<br/>\ntwo')).toBe('one\\\ntwo');
    expect(convertHtmlToMarkdown('one<br>')).toBe('one');
    expect(convertHtmlToMarkdown('one<br>\n\ntwo')).toBe('one\n\ntwo');
    expect(convertHtmlToMarkdown('one<br>\n- item')).toBe('one\n- item');
  });

  it('keeps a line break where a backslash break would change the block', () => {
    for (const value of ['# a<br>b', '- a<br>b', '| a<br>b |', '<br>start']) {
      expect(convertHtmlToMarkdown(value)).toBe(value);
    }
  });
});

describe('convertHtmlToMarkdown block tags', () => {
  it('converts paragraphs, headings, and rules as separate blocks', () => {
    expect(convertHtmlToMarkdown('<p>One <b>two</b></p>\n<p>Three</p>')).toBe(
      'One **two**\n\nThree'
    );
    expect(convertHtmlToMarkdown('<h1>Title</h1>\n<h3>Sub <i>x</i></h3>')).toBe(
      '# Title\n\n### Sub *x*'
    );
    expect(convertHtmlToMarkdown('Above\n<hr>\nBelow')).toBe('Above\n\n---\n\nBelow');
    expect(convertHtmlToMarkdown('<p>first\n<p>second')).toBe('first\n\nsecond');
  });

  it('escapes text that would start a markdown block', () => {
    expect(convertHtmlToMarkdown('<p>- not a list</p>')).toBe(String.raw`\- not a list`);
    expect(convertHtmlToMarkdown('<p>1. not a list</p>')).toBe(String.raw`1\. not a list`);
    expect(convertHtmlToMarkdown('<h2>C #</h2>')).toBe(String.raw`## C \#`);
  });

  it('converts nested lists with their numbering', () => {
    expect(
      convertHtmlToMarkdown(
        '<ul>\n  <li>One</li>\n  <li>Two\n    <ol start="3"><li>Three</li><li>Four</li></ol>\n  </li>\n</ul>'
      )
    ).toBe('- One\n- Two\n  3. Three\n  4. Four');
    expect(convertHtmlToMarkdown('<ol><li>a<li>b</ol>')).toBe('1. a\n2. b');
  });

  it('converts blockquotes, including paragraphs and lists inside them', () => {
    expect(convertHtmlToMarkdown('<blockquote><p>One</p><p>Two</p></blockquote>')).toBe(
      '> One\n>\n> Two'
    );
    expect(convertHtmlToMarkdown('<blockquote>Quote<ul><li>x</li></ul></blockquote>')).toBe(
      '> Quote\n>\n> - x'
    );
  });

  it('converts pre and pre > code into fenced code', () => {
    expect(
      convertHtmlToMarkdown(
        '<pre><code class="language-ts">const a = 1 &lt; 2;\nconst b = `t`;\n</code></pre>'
      )
    ).toBe('```ts\nconst a = 1 < 2;\nconst b = `t`;\n```');
    expect(convertHtmlToMarkdown('<pre>\n```\nfence\n```\n</pre>')).toBe(
      '<pre>\n```\nfence\n```\n</pre>'
    );
    expect(convertHtmlToMarkdown('<pre>plain <b>x</b></pre>')).toBe('<pre>plain <b>x</b></pre>');
  });

  it('converts a simple table into a GFM table', () => {
    expect(
      convertHtmlToMarkdown(
        '<table>\n<thead><tr><th>Name</th><th>Note</th></tr></thead>\n<tbody>\n<tr><td><b>Kilo</b></td><td>a|b</td></tr>\n<tr><td>Short</td></tr>\n</tbody>\n</table>'
      )
    ).toBe('| Name | Note |\n| --- | --- |\n| **Kilo** | a\\|b |\n| Short |  |');
    expect(convertHtmlToMarkdown('<table><tr><th>A</th></tr><tr><td>1</td></tr></table>')).toBe(
      '| A |\n| --- |\n| 1 |'
    );
  });

  it('keeps tables markdown cannot express as HTML', () => {
    for (const html of [
      '<table><tr><td colspan="2">wide</td></tr></table>',
      '<table><tr><td>no header</td></tr></table>',
      '<table><tr><th>A</th></tr><tr><td>1</td><td>2</td></tr></table>',
      '<table><tr><th>A</th></tr><tr><td><ul><li>x</li></ul></td></tr></table>',
      '<table><tr><th>A<br>B</th></tr></table>',
      '<table class="x"><tr><th>A</th></tr></table>',
    ]) {
      expect(convertHtmlToMarkdown(html)).toBe(html);
    }
  });

  it('keeps a block that does not own its lines as HTML', () => {
    expect(convertHtmlToMarkdown('Text <p>inline</p>')).toBe('Text <p>inline</p>');
    expect(convertHtmlToMarkdown('- <p>item</p>')).toBe('- <p>item</p>');
  });
});

describe('convertHtmlToMarkdown leaves the rest alone', () => {
  it('keeps unknown tags and tags with meaningful attributes, with their children', () => {
    for (const html of [
      '<span style="color:red"><b>x</b></span>',
      '<kbd>Ctrl</kbd>',
      '<details><summary>More</summary><b>body</b></details>',
      '<custom-tag>hello</custom-tag>',
      '<b class="loud">x</b>',
      '<div>\n<p>x</p>\n</div>',
    ]) {
      expect(convertHtmlToMarkdown(html)).toBe(html);
    }
  });

  it('converts around elements it keeps', () => {
    expect(convertHtmlToMarkdown('Press <kbd>Ctrl</kbd> and <b>go</b>')).toBe(
      'Press <kbd>Ctrl</kbd> and **go**'
    );
  });

  it('keeps misnested markup as HTML', () => {
    expect(convertHtmlToMarkdown('<b><i>x</b></i>')).toBe('<b><i>x</b></i>');
  });

  it('never converts inside code spans, fences, indented code, or comments', () => {
    for (const value of [
      '`<b>x</b>`',
      '``a <b>x</b> ` b``',
      '```html\n<b>x</b>\n```',
      '~~~\n<b>x</b>\n~~~',
      '> ```\n> <b>x</b>\n> ```',
      'para\n\n    <b>x</b>',
      '# Title\n    <b>x</b>',
      '***\n    <b>x</b>',
      '```\ncode\n```\n    <b>x</b>',
      '```\n    ```\n<b>x</b>\n```',
      '<!-- <b>x</b> -->',
      String.raw`\<b>x</b>`,
    ]) {
      expect(convertHtmlToMarkdown(value)).toBe(value);
    }
    expect(convertHtmlToMarkdown('```\n<b>x</b>\n```\n\n<b>y</b>')).toBe(
      '```\n<b>x</b>\n```\n\n**y**'
    );
    // An indented line inside a paragraph continues it, so it still converts.
    expect(convertHtmlToMarkdown('para\n    <b>y</b>')).toBe('para\n    **y**');
  });

  it('returns a value with no tags unchanged', () => {
    for (const value of ['', 'plain', 'a < b and c > d', '<https://example.com>']) {
      expect(convertHtmlToMarkdown(value)).toBe(value);
    }
  });
});

describe('convertHtmlToMarkdown while streaming', () => {
  it('converts an open inline tag as if it closed at the end', () => {
    expect(convertHtmlToMarkdown('Hello <b>wor')).toBe('Hello **wor**');
    expect(convertHtmlToMarkdown('Hello <b>world</')).toBe('Hello **world**');
    expect(convertHtmlToMarkdown('Hello <b>world</b>')).toBe('Hello **world**');
    expect(convertHtmlToMarkdown('<a href="https://x.dev">Do')).toBe('[Do](https://x.dev)');
  });

  it('leaves a tag that has not finished arriving as text', () => {
    expect(convertHtmlToMarkdown('Hello <b')).toBe('Hello <b');
    expect(convertHtmlToMarkdown('Hello <a href="https://x')).toBe('Hello <a href="https://x');
  });

  it('closes an open inline tag at the end of its paragraph', () => {
    expect(convertHtmlToMarkdown('<b>one\n\ntwo')).toBe('**one**\n\ntwo');
  });

  it('converts a streaming table and list row by row', () => {
    const table = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td';
    expect(convertHtmlToMarkdown(table)).toBe('| A | B |\n| --- | --- |\n| 1 |  |');
    expect(convertHtmlToMarkdown('<ul><li>one</li><li>tw')).toBe('- one\n- tw');
  });

  it('does not convert inside a code span or fence that is still open', () => {
    expect(convertHtmlToMarkdown('Use `<b>x</b>')).toBe('Use `<b>x</b>');
    expect(convertHtmlToMarkdown('```\n<b>x</b>')).toBe('```\n<b>x</b>');
  });

  it('never throws on any prefix of a mixed document', () => {
    const document =
      '# T\n\n<p>A <b>b</b> <a href="https://x.dev" title="t">c</a><br>d</p>\n\n<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>`c`</td></tr></tbody></table>\n\n```\n<b>x</b>\n```\n<details><summary>s</summary>\n\nbody\n\n</details>\n<ul><li>1<ol><li>2</li></ol></li></ul>';
    for (let end = 0; end <= document.length; end += 1) {
      expect(() => convertHtmlToMarkdown(document.slice(0, end))).not.toThrow();
    }
  });
});
