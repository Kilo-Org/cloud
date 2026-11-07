import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

jest.mock('react-markdown', () =>
  process.getBuiltinModule('module').createRequire(__filename)('react-markdown')
);
jest.mock('remark-gfm', () =>
  process.getBuiltinModule('module').createRequire(__filename)('remark-gfm')
);

import type { FilePart } from './types';
import { TextPartRenderer, FilePartRenderer } from './part-content';
import type { NativeSessionState } from '@kilocode/cloud-agent-sdk';
import { readNativeConversation } from '@kilocode/cloud-agent-sdk/native-conversation-source';
import { kilo2AssetKey } from '@kilocode/cloud-agent-sdk/kilo2-source-messages';

Object.assign(globalThis, { React });

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

function renderText(text: string, isStreaming = false): string {
  return renderToStaticMarkup(React.createElement(TextPartRenderer, { text, isStreaming }));
}

describe('TextPartRenderer code blocks', () => {
  it.each(['', 'markdown', 'sh'])(
    'provides a copy control for a fenced block with language %j',
    language => {
      const markup = renderText(
        `Before\n\n\`\`\`${language}\nfirst line\n  <tag> & value\n\`\`\`\n\nAfter`
      );

      expect(markup).toContain('aria-label="Copy code"');
      expect(markup).toContain(
        `<code${language ? ` class="language-${language}"` : ''}>first line\n  &lt;tag&gt; &amp; value\n</code>`
      );
      expect(markup).toContain('<p>Before</p>');
      expect(markup).toContain('<p>After</p>');
      expect(markup).not.toMatch(/<pre\b[^>]*>(?:(?!<\/pre>)[\s\S])*<button\b/);
      expect(markup).not.toContain('>Code<');
    }
  );

  it('keeps long snippets fully expanded', () => {
    const content = 'line\n'.repeat(200) + 'last line';
    const markup = renderText(`\`\`\`\n${content}\n\`\`\``);

    expect(markup).toContain(`<code>${content}\n</code>`);
    expect(markup).not.toContain('max-h-80');
  });

  it('provides a separate copy control for each block, including indented code', () => {
    const markup = renderText('```\nfirst\n```\n\n    second\n');

    expect(markup.match(/aria-label="Copy code"/g)).toHaveLength(2);
    expect(markup).toContain('<code>first\n</code>');
    expect(markup).toContain('<code>second\n</code>');
  });

  it('renders a copyable incomplete fence while streaming', () => {
    const markup = renderText('```sh\nprintf hello\n  pwd', true);

    expect(markup).toContain('aria-label="Copy code"');
    expect(markup).toContain('<code class="language-sh">printf hello\n  pwd\n</code>');
  });

  it('overlays the copy control with hover, keyboard focus, and touch visibility', () => {
    const markup = renderText('```\nexample\n```');

    expect(markup).toContain('group/code relative');
    expect(markup).toContain('absolute top-2 right-2 opacity-0');
    expect(markup).toContain('group-hover/code:opacity-100');
    expect(markup).toContain('group-focus-within/code:opacity-100');
    expect(markup).toContain('pointer-coarse:opacity-100');
    expect(markup).toContain('aria-label="Code block"');
    expect(markup).toContain('tabindex="0"');
  });

  it('leaves inline code and ordinary blockquotes unchanged', () => {
    const markup = renderText('Use `value` here.\n\n> A quoted sentence');

    expect(markup).toContain('<code>value</code>');
    expect(markup).toContain('<blockquote>');
    expect(markup).not.toContain('Copy code');
  });
});

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
      React.createElement(FilePartRenderer, {
        part: imageFilePart('https://files.example.com/screenshot.png'),
      })
    );

    expect(markup).toContain('<img');
    expect(markup).toContain('src="https://files.example.com/screenshot.png"');
    expect(markup).toContain('alt="screenshot.png"');
  });
});

describe('native tool files through the existing FilePartRenderer', () => {
  it('renders authorized native image bytes and a real PDF download without another renderer', () => {
    const imageURI = `media:${'a'.repeat(64)}`;
    const pdfURI = `media:${'b'.repeat(64)}`;
    const image =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jDXsAAAAASUVORK5CYII=';
    const pdf = 'data:application/pdf;base64,JVBERi0xLjcK';
    const state: NativeSessionState = {
      connection: 'connected',
      runnerConnected: true,
      session: {
        id: 'ses_native',
        origin: { directory: '/owned' },
        time: { created: 1, updated: 2 },
      },
      snapshot: { position: 2, revision: 2 },
      pending: { permissions: [], questions: [] },
      events: [],
      commands: {},
      assetURLs: {
        [kilo2AssetKey('msg_files_000000_file_0', imageURI, 'image/png')]: image,
        [kilo2AssetKey('msg_files_000000_file_1', pdfURI, 'application/pdf')]: pdf,
      },
      messages: [
        {
          seq: 1,
          message: {
            id: 'msg_files',
            type: 'assistant',
            time: { created: 1, completed: 2 },
            content: [
              {
                type: 'tool',
                id: 'read-call',
                name: 'read',
                time: { created: 1, completed: 2 },
                state: {
                  status: 'completed',
                  input: { path: '/owned' },
                  content: [
                    { type: 'file', uri: imageURI, mime: 'image/png', name: 'snapshot.png' },
                    { type: 'file', uri: pdfURI, mime: 'application/pdf', name: 'report.pdf' },
                  ],
                },
              },
            ],
          },
        },
      ],
    };
    const files = readNativeConversation(state)
      .messages.flatMap(message => message.parts)
      .filter(part => part.type === 'file');
    expect(files).toHaveLength(2);
    const markup = renderToStaticMarkup(
      React.createElement(
        React.Fragment,
        null,
        files.map(part => React.createElement(FilePartRenderer, { key: part.id, part }))
      )
    );
    expect(markup).toContain(`src="${image}"`);
    expect(markup).toContain('alt="snapshot.png"');
    expect(markup).toContain(`href="${pdf}"`);
    expect(markup).toContain('download="report.pdf"');
    expect(markup.match(/<img\b/g)).toHaveLength(1);
    expect(markup.match(/<a\b/g)).toHaveLength(1);
    expect(markup).not.toContain('media:');
    expect(markup).not.toContain('file:///owned');
  });

  it.each([
    'data:text/html;base64,PHNjcmlwdD4=',
    'javascript:alert(1)',
    'data:application/pdf;base64,not base64',
  ])('never turns an unsafe PDF attachment into a link (%s)', url => {
    const markup = renderToStaticMarkup(
      React.createElement(FilePartRenderer, {
        part: { ...imageFilePart(url), mime: 'application/pdf', filename: 'report.pdf' },
      })
    );
    expect(markup).not.toContain('<a');
    expect(markup).not.toContain('href=');
  });
});
