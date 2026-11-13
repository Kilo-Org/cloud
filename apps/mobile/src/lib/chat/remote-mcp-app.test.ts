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

  it('falls back to nothing when the metadata is not the shape the spec defines', () => {
    expect(contentSecurityPolicy({ ui: { csp: { connectDomains: 'https://api.example' } } })).toBe(
      contentSecurityPolicy(undefined)
    );
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
          connectDomains: [
            '*',
            "'unsafe-eval'",
            'https://ok.example',
            'https://a.example/x;y',
            'https://*',
            'https://*.example',
            'http://*',
            'https://*:8443',
            'https://ok.example/path',
            'https://user@ok.example',
          ],
          resourceDomains: ["'unsafe-inline' 'unsafe-eval'", 'data:text/html,<script>'],
        },
      },
    });
    expect(policy).toContain('connect-src https://ok.example');
    expect(policy).not.toContain('*');
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).not.toContain('data:text/html');
    expect(policy).not.toContain('/path');
    expect(policy).not.toContain('@');
  });

  it('names each source as the origin it is, and nothing longer', () => {
    const policy = contentSecurityPolicy({
      ui: {
        csp: {
          connectDomains: [
            'https://api.example:8443',
            'wss://socket.example',
            'https://slash.example/',
            'https://смр.example',
          ],
          resourceDomains: ['http://127.0.0.1:8080', 'https://cdn.example'],
          baseUriDomains: ['https://[::1]:3000'],
        },
      },
    });
    expect(policy).toContain(
      'connect-src https://api.example:8443 wss://socket.example https://slash.example https://смр.example'
    );
    expect(policy).toContain(
      "script-src 'unsafe-inline' http://127.0.0.1:8080 https://cdn.example"
    );
    expect(policy).toContain('base-uri https://[::1]:3000');
  });

  it('drops a port no origin can have', () => {
    const policy = contentSecurityPolicy({
      ui: {
        csp: {
          connectDomains: [
            'https://api.example:0',
            'https://api.example:99999',
            'https://api.example:443',
          ],
        },
      },
    });
    expect(policy).toContain('connect-src https://api.example:443');
    expect(policy).not.toContain(':0');
    expect(policy).not.toContain('99999');
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

  it('keeps the doctype first, so a document without a head is not drawn in quirks mode', () => {
    const document = viewDocument(
      '<!doctype html><html><body><p>a view</p></body></html>',
      "default-src 'none'"
    );
    expect(document.startsWith('<!doctype html>')).toBe(true);
    expect(document.indexOf('Content-Security-Policy')).toBeLessThan(
      document.indexOf('<p>a view</p>')
    );
  });

  it('keeps the policy ahead of every part of the document, at any head position', () => {
    /* Each resource writes its head marker in a different position; the policy
       is still the first token the parser reads, after the doctype. */
    const documents = [
      '<!-- <head> --><html><head><title>x</title></head><body></body></html>',
      '<script>const tag = "<head>";</script><html><head><title>x</title></head></html>',
      '<style>/* <head> */</style><html><head><title>x</title></head></html>',
      '<html data-note="<head>"><head><title>x</title></head></html>',
    ];
    for (const html of documents) {
      const document = viewDocument(html, "default-src 'none'");
      expect(document.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
      expect(document.indexOf('Content-Security-Policy')).toBeLessThan(document.indexOf('<head>'));
      expect(document.split('Content-Security-Policy')).toHaveLength(2);
    }
  });

  it('keeps a byte-order mark and a doctype in front of the policy', () => {
    const document = viewDocument(
      '\uFEFF<!doctype html><!-- <head> --><html><head></head></html>',
      "default-src 'none'"
    );
    expect(document.startsWith('\uFEFF<!doctype html><meta ')).toBe(true);
    expect(document.indexOf('Content-Security-Policy')).toBeLessThan(
      document.indexOf('<!-- <head> -->')
    );
  });

  it('keeps a doctype that follows comments and whitespace in front of the policy', () => {
    const document = viewDocument(
      '<!-- a note -->\n<!doctype html><html><body><p>a view</p></body></html>',
      "default-src 'none'"
    );
    expect(document.startsWith('<!-- a note -->\n<!doctype html><meta ')).toBe(true);
    expect(document.indexOf('Content-Security-Policy')).toBeLessThan(
      document.indexOf('<p>a view</p>')
    );
  });

  it('places the policy in front of every token the document’s prologue does not own', () => {
    /* Each document starts with a declaration that a parser reads as a comment
       of some length, and then with markup of its own. The policy follows the
       prologue the parser actually reads, so it comes before that markup. */
    const documents = [
      '<?x><script>run()</script>?><!doctype html><html><head></head></html>',
      '<!--><script>run()</script>--><!doctype html><html><head></head></html>',
      '<!---><script>run()</script><!doctype html><html><head></head></html>',
      '<!note><script>run()</script><!doctype html><html><head></head></html>',
      '<!----><script>run()</script><!doctype html><html><head></head></html>',
      '<!-- never closed <script>run()</script>',
    ];
    for (const html of documents) {
      const document = viewDocument(html, "default-src 'none'");
      expect(document.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
      expect(document.indexOf('Content-Security-Policy')).toBeLessThan(
        document.indexOf('<script>')
      );
      expect(document.split('Content-Security-Policy')).toHaveLength(2);
    }
  });

  it('keeps a byte-order mark first when the document has no doctype', () => {
    const document = viewDocument('\uFEFF<script></script>', "default-src 'none'");
    expect(document.startsWith('\uFEFF<meta ')).toBe(true);
    expect(document.indexOf('Content-Security-Policy')).toBeLessThan(document.indexOf('<script>'));
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
