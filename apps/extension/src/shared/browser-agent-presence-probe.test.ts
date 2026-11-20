/* eslint-disable import/no-nodejs-modules, no-new-func, typescript/no-implied-eval, typescript/no-unsafe-call, typescript/no-unsafe-type-assertion, vitest/no-conditional-in-test -- the probe is page-side source; running that exact string against a test DOM is the point, and the fixture branches per shadow-root mode */
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { SENSITIVE_FIELD_PRESENCE_PROBE_EXPRESSION } from './browser-agent-probes';

/*
 * The presence probe is page-side source: it runs in the tab's isolated world.
 * These tests execute that exact expression against a real DOM (jsdom) with
 * open and closed shadow roots, so a walk that stops at `document` fails here
 * instead of silently letting a web component's password field through.
 */

const PAYLOAD_SCHEMA = { closed: false, present: false };

type Payload = typeof PAYLOAD_SCHEMA;

const probe = (build: (document: Document) => void): Payload => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const { document } = dom.window;

  build(document);

  // Same expression the extension sends; only the globals it needs are bound.
  const run = new Function('document', `return ${SENSITIVE_FIELD_PRESENCE_PROBE_EXPRESSION};`);

  return JSON.parse(String(run(document))) as Payload;
};

const attach = (document: Document, mode: ShadowRootMode, html: string): void => {
  const host = document.createElement('my-widget');

  document.body.append(host);
  host.attachShadow({ mode }).innerHTML = html;
};

describe('sensitive field presence probe', () => {
  it('sees a password field in the page itself', () => {
    expect(
      probe(document => {
        const input = document.createElement('input');

        input.type = 'password';
        document.body.append(input);
      })
    ).toStrictEqual({ closed: false, present: true });
  });

  it('sees a password field inside an open shadow root', () => {
    expect(
      probe(document => {
        attach(document, 'open', '<label>Pin<input type="password"></label>');
      })
    ).toStrictEqual({ closed: false, present: true });
  });

  it('sees a card field two open shadow roots deep', () => {
    expect(
      probe(document => {
        attach(document, 'open', '<inner-widget><span slot="x"></span></inner-widget>');

        const [host] = [...document.querySelectorAll('my-widget')];
        const inner = host?.shadowRoot?.querySelector('inner-widget');

        inner?.attachShadow({ mode: 'open' }).append(
          ((): Element => {
            const input = document.createElement('input');

            input.setAttribute('autocomplete', 'cc-number');

            return input;
          })()
        );
      })
    ).toStrictEqual({ closed: false, present: true });
  });

  it('reports a custom element with a closed root as possibly sensitive', () => {
    expect(
      probe(document => {
        attach(document, 'closed', '<input type="password">');
      })
    ).toStrictEqual({ closed: true, present: false });
  });

  it('stays plain on a page with no protected field and no custom element', () => {
    expect(
      probe(document => {
        const input = document.createElement('input');

        input.type = 'email';
        document.body.append(input);
      })
    ).toStrictEqual({ closed: false, present: false });
  });
});
