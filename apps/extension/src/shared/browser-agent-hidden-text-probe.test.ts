/* eslint-disable no-new-func, typescript/no-implied-eval, typescript/no-unsafe-call, typescript/no-unsafe-type-assertion -- the probe is page-side source; running that exact string against a test DOM is the point */
import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { hiddenTextProbeExpression, readFrameHiddenText } from './browser-agent-probes';

/*
 * The hidden-text probe is page-side source: it runs in the tab's isolated
 * world. These tests execute it against a jsdom document, next to the probe it
 * replaced, which checked every text node and returned every hidden text. The
 * new probe checks only the names the snapshot prints, so on every one of
 * those names both must give the same answer.
 */
const UNSCOPED_HIDDEN_TEXT_PROBE = `(() => {
  var HIDDEN = [];
  var seen = typeof Set === 'function' ? new Set() : null;
  var collapse = function (value) { return String(value == null ? '' : value).replace(/\\s+/g, ' ').trim(); };
  var add = function (value) { var text = collapse(value); if (text === '') { return; } if (seen !== null) { if (seen.has(text)) { return; } seen.add(text); } HIDDEN.push(text); };
  var colorEqualsBackground = function (element) {
    var own = getComputedStyle(element);
    var color = own.color;
    var node = element;
    while (node !== null && node.nodeType === 1) {
      var style = getComputedStyle(node);
      var background = style.backgroundColor;
      var transparent = background === '' || background === 'transparent' || /rgba\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*0\\s*\\)/.test(background);
      if (!transparent) { return color === background; }
      node = node.parentElement;
    }
    return false;
  };
  var isHiddenElement = function (element) {
    if (element.closest('[aria-hidden="true"]') !== null) { return true; }
    var style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') { return true; }
    var rects = element.getClientRects();
    if (rects.length === 0) { return true; }
    var rect = rects[0];
    if (rect.width === 0 || rect.height === 0) { return true; }
    var doc = document.documentElement;
    var scrollHeight = Math.max(doc ? doc.scrollHeight : 0, window.innerHeight || 0);
    var scrollWidth = Math.max(doc ? doc.scrollWidth : 0, window.innerWidth || 0);
    var left = rect.left + (window.scrollX || 0);
    var top = rect.top + (window.scrollY || 0);
    if (left + rect.width < 0 || top + rect.height < 0) { return true; }
    if (left > scrollWidth || top > scrollHeight) { return true; }
    return colorEqualsBackground(element);
  };
  var root = document.body || document.documentElement;
  if (root === null) { return JSON.stringify({ hidden: [] }); }
  if (isHiddenElement(root)) { add(root.textContent); return JSON.stringify({ hidden: HIDDEN }); }
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  var node = walker.nextNode();
  while (node !== null) {
    var parent = node.parentElement;
    if (parent !== null && collapse(node.data) !== '' && isHiddenElement(parent)) { add(node.data); }
    node = walker.nextNode();
  }
  return JSON.stringify({ hidden: HIDDEN });
})()`;

interface ProbePage {
  /** Every distinct collapsed text in the page: the names a snapshot of it could print. */
  readonly texts: readonly string[];
  /** Runs one probe expression in the page; returns its hidden texts and the style reads it made. */
  readonly run: (expression: string) => {
    readonly getComputedStyleCalls: number;
    readonly hidden: ReadonlySet<string>;
  };
  readonly elementCount: number;
}

/**
 * A jsdom page for the probe. The page has no layout, so an element's
 * `data-rect="left,top,width,height"` (or `none`) stands in for its client
 * rect; any other element gets a visible 100×20 box.
 */
const probePage = (
  html: string,
  bodyAttributes: Readonly<Record<string, string>> = {}
): ProbePage => {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  const { window } = dom;
  const { document } = window;

  for (const [name, value] of Object.entries(bodyAttributes)) {
    document.body.setAttribute(name, value);
  }

  vi.spyOn(window.Element.prototype, 'getClientRects').mockImplementation(function getClientRects(
    this: Element
  ) {
    const spec = this instanceof window.HTMLElement ? this.dataset['rect'] : undefined;

    if (spec === 'none') {
      return [] as unknown as DOMRectList;
    }

    const [left = 10, top = 10, width = 100, height = 20] = (spec ?? '').split(',').map(Number);

    return [{ height, left, top, width }] as unknown as DOMRectList;
  });

  const texts = new Set<string>();
  const walker = document.createTreeWalker(document.body, window.NodeFilter.SHOW_TEXT);

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = (node.textContent ?? '').replaceAll(/\s+/gu, ' ').trim();

    if (text !== '') {
      texts.add(text);
    }
  }

  return {
    elementCount: document.querySelectorAll('*').length,
    run: expression => {
      let getComputedStyleCalls = 0;
      const countingGetComputedStyle = (element: Element): CSSStyleDeclaration => {
        getComputedStyleCalls += 1;

        return window.getComputedStyle(element);
      };
      const evaluate = new Function(
        'document',
        'window',
        'getComputedStyle',
        'NodeFilter',
        `return ${expression};`
      );
      const payload = JSON.parse(
        String(evaluate(document, window, countingGetComputedStyle, window.NodeFilter))
      ) as { hidden: string[] };

      return { getComputedStyleCalls, hidden: new Set(payload.hidden) };
    },
    texts: [...texts],
  };
};

/** Runs both probes and checks the scoped one answers every candidate as the unscoped one does. */
const expectAgreement = (page: ProbePage, candidates: readonly string[]): ReadonlySet<string> => {
  const unscoped = page.run(UNSCOPED_HIDDEN_TEXT_PROBE).hidden;
  const scoped = page.run(hiddenTextProbeExpression(candidates)).hidden;

  expect(candidates.filter(candidate => scoped.has(candidate))).toStrictEqual(
    candidates.filter(candidate => unscoped.has(candidate))
  );
  expect([...scoped].every(text => candidates.includes(text))).toBe(true);

  return scoped;
};

const HIDDEN_FIXTURE = `
<h1>Heading text</h1>
<p>Visible line</p>
<p style="display: none">Display none text</p>
<p style="visibility: hidden">Visibility hidden text</p>
<p style="opacity: 0">Opacity zero text</p>
<div aria-hidden="true"><span>Aria hidden child</span></div>
<p data-rect="none">No box text</p>
<p data-rect="10,10,0,20">Zero width text</p>
<p data-rect="-5000,10,100,20">Offscreen left text</p>
<p data-rect="10,-5000,100,20">Offscreen top text</p>
<p data-rect="5000,10,100,20">Past the right edge text</p>
<p style="color: rgb(255, 255, 255); background-color: rgb(255, 255, 255)">Same as own background</p>
<div style="background-color: rgb(10, 20, 30)"><div style="background-color: rgba(0, 0, 0, 0)"><span style="color: rgb(10, 20, 30)">Same as ancestor background</span></div></div>
<div style="background-color: rgb(10, 20, 30)"><span style="color: rgb(11, 20, 30)">Near ancestor background</span></div>
<div style="background-color: rgb(10, 20, 30)"><span style="color: rgb(10, 20, 30)">Shared parent one</span> <b style="color: rgb(10, 20, 30)">Shared parent two</b></div>
<p>Duplicated text</p><p style="display: none">Duplicated text</p>
<p style="display: none">Hidden first copy</p><p>Hidden first copy</p>
<button>Shown button</button><button style="opacity: 0">Ghost button</button>
<p>  Spaced
   out   text </p>
`;

const rowsPage = (cells: string): ProbePage =>
  probePage(
    [...Array.from({ length: 50 }).keys()]
      .map(
        index => `<div><section><p><span>Row ${String(index)}</span>${cells}</p></section></div>`
      )
      .join('')
  );

describe('candidate-scoped hidden text probe', () => {
  it('agrees with the unscoped probe on every text of a page with each kind of hidden text', () => {
    const page = probePage(HIDDEN_FIXTURE);
    const hidden = expectAgreement(page, [...page.texts, 'Not on the page']);

    expect([...hidden].toSorted()).toStrictEqual(
      [
        'Aria hidden child',
        'Display none text',
        'Duplicated text',
        'Ghost button',
        'Hidden first copy',
        'No box text',
        'Offscreen left text',
        'Offscreen top text',
        'Opacity zero text',
        'Past the right edge text',
        'Same as ancestor background',
        'Same as own background',
        'Shared parent one',
        'Shared parent two',
        'Visibility hidden text',
        'Zero width text',
      ].toSorted()
    );
  });

  it('agrees with the unscoped probe on a subset of the texts', () => {
    const page = probePage(HIDDEN_FIXTURE);

    expect([
      ...expectAgreement(page, [
        'Visible line',
        'Duplicated text',
        'Spaced out text',
        'Ghost button',
      ]),
    ]).toStrictEqual(['Duplicated text', 'Ghost button']);
  });

  it('agrees with the unscoped probe when the whole body is hidden', () => {
    const page = probePage('<p>Only</p>', { 'aria-hidden': 'true' });

    expect([...expectAgreement(page, ['Only', 'Elsewhere'])]).toStrictEqual(['Only']);
  });

  it('reads no style but the body’s for a page whose text the snapshot does not print', () => {
    const page = rowsPage('');

    // The body is still checked: a hidden body hides its whole text at once.
    expect(
      page.run(hiddenTextProbeExpression(['Not on the page'])).getComputedStyleCalls
    ).toBeLessThanOrEqual(2);
  });

  it('reads each element’s style at most once, however many printed texts share it', () => {
    const page = rowsPage('<b>cell</b><i>cell</i>');

    // The unscoped probe read every text's parent and then its whole ancestor chain again for each text node.
    expect(
      page.run(hiddenTextProbeExpression(page.texts)).getComputedStyleCalls
    ).toBeLessThanOrEqual(page.elementCount);
  });
});

describe('reading a frame’s hidden text', () => {
  it('sends nothing when the snapshot prints no name', async () => {
    const send = vi.fn();

    await expect(readFrameHiddenText({ send }, 'main', [])).resolves.toStrictEqual(new Set());
    expect(send).not.toHaveBeenCalled();
  });
});
