import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

jest.mock('react-markdown', () =>
  process.getBuiltinModule('module').createRequire(__filename)('react-markdown')
);
jest.mock('remark-gfm', () =>
  process.getBuiltinModule('module').createRequire(__filename)('remark-gfm')
);

import type { FilePart, TextPart } from './types';
import { PartRenderer } from './PartRenderer';

Object.assign(globalThis, { React });

function textPart(text: string): TextPart {
  return {
    id: 'text-1',
    sessionID: 'ses-1',
    messageID: 'msg-1',
    type: 'text',
    text,
    time: { start: 1, end: 2 },
  };
}

function imageFilePart(url: string): FilePart {
  return {
    id: 'file-1',
    sessionID: 'ses-1',
    messageID: 'msg-1',
    type: 'file',
    mime: 'image/png',
    filename: 'screenshot.png',
    url,
  };
}

function renderText(text: string): string {
  return renderToStaticMarkup(
    React.createElement(PartRenderer, { part: textPart(text), isStreaming: false })
  );
}

describe('TextPartRenderer markdown images', () => {
  it('renders a markdown image as a link to its source, labeled with the alt text', () => {
    const markup = renderText('![Build status](https://cdn.example.com/status.png)');

    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('as="image"');
    expect(markup).toContain('href="https://cdn.example.com/status.png"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain('>Build status</a>');
  });

  it('renders an image inside a link as one link', () => {
    const markup = renderText(
      '[![Build status](https://cdn.example.com/status.png)](https://example.com/build)'
    );

    expect(markup.match(/<a /g) ?? []).toHaveLength(1);
    expect(markup).toContain('href="https://example.com/build"');
    expect(markup).toContain('Build status');
    expect(markup).not.toContain('<img');
  });

  it('labels an image without alt text', () => {
    const markup = renderText('![](https://cdn.example.com/status.png)');

    expect(markup).not.toContain('<img');
    expect(markup).toContain('>Image</a>');
  });

  it('renders only http(s) image sources as links', () => {
    const relative = renderText('![diagram](./assets/diagram.png)');
    expect(relative).not.toContain('<img');
    expect(relative).not.toContain('href=');
    expect(relative).toContain('diagram');

    const jsScheme = renderText('![payload](javascript:alert)');
    expect(jsScheme).not.toContain('<img');
    expect(jsScheme).not.toContain('javascript:');
    expect(jsScheme).toContain('payload');
  });

  it('still renders an ordinary link as an anchor', () => {
    const markup = renderText('[Docs](https://example.com/docs)');

    expect(markup).toContain('href="https://example.com/docs"');
    expect(markup).toContain('>Docs</a>');
  });
});

describe('FilePartRenderer images', () => {
  it('renders an image attachment as an img element', () => {
    const markup = renderToStaticMarkup(
      React.createElement(PartRenderer, {
        part: imageFilePart('https://files.example.com/screenshot.png'),
        isStreaming: false,
      })
    );

    expect(markup).toContain('<img');
    expect(markup).toContain('src="https://files.example.com/screenshot.png"');
    expect(markup).toContain('alt="screenshot.png"');
  });
});
