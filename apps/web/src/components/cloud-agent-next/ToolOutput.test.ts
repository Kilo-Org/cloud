import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { normalizeTerminalOutput } from './normalize-terminal-output';

jest.mock('react-markdown', () =>
  process.getBuiltinModule('module').createRequire(__filename)('react-markdown')
);
jest.mock('remark-gfm', () =>
  process.getBuiltinModule('module').createRequire(__filename)('remark-gfm')
);

import { ToolCodeBlock, ToolMarkdown } from './ToolOutput';

Object.assign(globalThis, { React });

function markdown(content: string): string {
  return renderToStaticMarkup(React.createElement(ToolMarkdown, { content }));
}

describe('normalizeTerminalOutput', () => {
  it.each([
    ['plain\n  indented\ttext\n', 'plain\n  indented\ttext\n'],
    ['first\r\nsecond\r\n', 'first\nsecond\n'],
    ['10%\r50%\r100%', '100%'],
    ['10%\r50%\r', '50%'],
    ['10%\r50%\r\r', '50%'],
    ['\r\r', ''],
    ['first\r\n10%\r100%\r\ndone', 'first\n100%\ndone'],
    ['\u001b[31mfailed\u001b[0m\r\u001b[32mpassed\u001b[0m\n', 'passed\n'],
  ])('normalizes %j without losing the final visible frame', (input, expected) => {
    expect(normalizeTerminalOutput(input)).toBe(expected);
  });
});

describe('ToolCodeBlock', () => {
  it('escapes code, preserves all lines, and provides a separately labelled copy control', () => {
    const content = 'printf "<script>"\n' + 'line\n'.repeat(200) + 'last line';
    const html = renderToStaticMarkup(
      React.createElement(ToolCodeBlock, { content, label: 'Command' })
    );

    expect(html).toContain('aria-label="Copy command"');
    expect(html).toContain('aria-label="Command"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('last line</code>');
    expect(html).not.toContain('<script>');
    expect(html).not.toMatch(/<pre\b[^>]*>[\s\S]*<button\b/);
    expect(html).not.toContain('aria-busy=');
  });

  it('keeps compact output accessible and copyable without a visible heading', () => {
    const content = 'first line\n  indented\nlast line';
    const html = renderToStaticMarkup(
      React.createElement(ToolCodeBlock, {
        content,
        label: 'Output',
        compact: true,
        isStreaming: true,
      })
    );

    expect(html).not.toContain('>Output<');
    expect(html).toContain('aria-label="Output"');
    expect(html).toContain('aria-label="Copy output"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(`<code>${content}</code>`);
    expect(html).not.toMatch(/<pre\b[^>]*>(?:(?!<\/pre>)[\s\S])*<button\b/);
  });

  it('marks a section busy only when explicitly requested', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCodeBlock, {
        content: 'new output',
        label: 'Output',
        isStreaming: true,
      })
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Copy output"');
  });
});

describe('ToolMarkdown', () => {
  it('renders GFM tables and strikethrough with copyable fenced code', () => {
    const html = markdown(
      '| Result |\n| --- |\n| ~~old~~ new |\n\n```sh\nprintf "<tag>"\npwd\n```'
    );

    expect(html).toContain('<table>');
    expect(html).toContain('<del>old</del>');
    expect(html).toContain('aria-label="Copy code"');
    expect(html).toContain('<code>printf &quot;&lt;tag&gt;&quot;\npwd</code>');
    expect(html).not.toMatch(/<pre\b[^>]*>\s*<div\b/);
  });

  it('keeps ordinary output line breaks and inline code without a block copy control', () => {
    const html = markdown('first line\nsecond line with `value`');

    expect(html).toContain('<p>first line\nsecond line with <code>value</code></p>');
    expect(html).toContain('prose-p:whitespace-pre-wrap');
    expect(html).not.toContain('Copy code');
  });

  it.each(['https://example.com/docs?q=1', 'http://example.com/docs'])(
    'allows safe HTTP links: %s',
    url => {
      const html = markdown(`[Read docs](${url})`);

      expect(html).toContain(`href="${url}"`);
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noopener noreferrer"');
    }
  );

  it.each([
    'javascript:alert%281%29',
    'data:text/html,unsafe',
    'file:///workspace/private.txt',
    '/workspace/private.txt',
    '../private.txt',
    '//example.com/private.txt',
    'vscode://file/workspace/private.txt',
    'mailto:test@example.com',
  ])('retains text rather than creating an unsafe or local link: %s', url => {
    const html = markdown(`[Keep this text](${url})`);

    expect(html).toContain('Keep this text');
    expect(html).not.toContain('href=');
  });

  it('escapes raw HTML instead of executing or embedding it', () => {
    const html = markdown('<script>alert(1)</script>\n<img src="x" onerror="alert(2)">');

    expect(html).not.toMatch(/<(script|img)\b/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('alert(1)');
  });

  it('renders image references as safe links or plain alt text without loading images', () => {
    const html = markdown(
      '![Diagram](https://example.com/diagram.png)\n![Local image](file:///workspace/image.png)'
    );

    expect(html).toContain('href="https://example.com/diagram.png"');
    expect(html).toContain('Diagram');
    expect(html).toContain('Local image');
    expect(html).not.toContain('href="file:');
    expect(html).not.toContain('<img');
  });
});
