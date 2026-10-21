import { describe, expect, it } from 'vitest';

import {
  contentSecurityPolicy,
  DEFAULT_VIEW_HEIGHT,
  MAX_VIEW_BYTES,
  VIEW_HOST_PAGE,
  viewArguments,
  viewDocument,
  viewHeightOf,
} from './remote-mcp-app';

/**
 * The document a view is drawn from, and the page that draws it: the policy a
 * server-declared resource gets, and the sandbox it cannot leave.
 */

describe('the policy a view runs under', () => {
  it('is nothing at all when the resource declared nothing', () => {
    expect(contentSecurityPolicy(undefined)).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "img-src data:; font-src data:; media-src data:; connect-src 'none'; " +
        "frame-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"
    );
    expect(contentSecurityPolicy({})).not.toContain('https://');
  });

  it('keeps only the origins the resource named, for what it named them for', () => {
    const policy = contentSecurityPolicy({
      ui: {
        csp: {
          connectDomains: ['https://api.example'],
          resourceDomains: ['https://cdn.example'],
        },
      },
    });
    expect(policy).toContain('connect-src https://api.example');
    expect(policy).toContain("script-src 'unsafe-inline' https://cdn.example");
    expect(policy).not.toContain('https://api.example https');
    expect(policy).toContain("frame-src 'none'");
  });

  it('drops a request that would widen the sandbox rather than trust it', () => {
    const policy = contentSecurityPolicy({
      ui: {
        csp: {
          connectDomains: ['*', "'unsafe-eval'", 'https://ok.example', 'https://a.example/x;y'],
          resourceDomains: ["'unsafe-inline' 'unsafe-eval'", 'data:text/html,<script>'],
        },
      },
    });
    expect(policy).toContain('connect-src https://ok.example');
    expect(policy).not.toContain('*');
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).not.toContain('data:text/html');
  });
});

describe('the document a view draws', () => {
  it('carries its policy before anything the resource wrote', () => {
    const document = viewDocument(
      '<html><head><title>x</title></head><body><script></script></body></html>',
      "default-src 'none'"
    );
    expect(document.indexOf('Content-Security-Policy')).toBeLessThan(document.indexOf('<title>'));
    expect(document.indexOf('Content-Security-Policy')).toBeLessThan(document.indexOf('<script>'));
  });

  it('still holds a document with no head, because a view is not required to have one', () => {
    const document = viewDocument('<p>a view</p>', "default-src 'none'");
    expect(document.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(document).toContain('<p>a view</p>');
  });
});

describe('the page a view is drawn in', () => {
  it('runs the view in a sandbox that can script and nothing else', () => {
    expect(VIEW_HOST_PAGE).toContain('sandbox="allow-scripts"');
    for (const widened of [
      'allow-same-origin',
      'allow-top-navigation',
      'allow-popups',
      'allow-forms',
      'allow-modals',
    ]) {
      expect(VIEW_HOST_PAGE).not.toContain(widened);
    }
  });

  it('relays only the sandbox’s own messages, and posts them as text', () => {
    expect(VIEW_HOST_PAGE).toContain('event.source !== view.contentWindow');
    expect(VIEW_HOST_PAGE).toContain('window.ReactNativeWebView.postMessage(text)');
  });

  it('is the only document the webview loads, and it loads it as a file', () => {
    // The sandbox's document comes from the resource, not from a URL the page
    // fetches: `srcdoc` is what keeps the view from reaching the network on
    // its own say.
    expect(VIEW_HOST_PAGE).toContain('view.srcdoc = html');
    expect(MAX_VIEW_BYTES).toBeGreaterThan(0);
  });
});

describe('the box a view takes in the transcript', () => {
  it('keeps the row where it was until the view reports a size', () => {
    expect(viewHeightOf(undefined)).toBe(DEFAULT_VIEW_HEIGHT);
    expect(viewHeightOf(210)).toBe(210);
  });

  it('holds a view that reports too little or too much inside the row', () => {
    expect(viewHeightOf(4)).toBe(120);
    expect(viewHeightOf(4096)).toBe(520);
  });
});

describe('the arguments a view is handed', () => {
  it('are the model’s, without the field the harness adds to every call', () => {
    expect(viewArguments({ wait: true, city: 'Oslo' })).toEqual({ city: 'Oslo' });
    expect(viewArguments({})).toEqual({});
  });
});
