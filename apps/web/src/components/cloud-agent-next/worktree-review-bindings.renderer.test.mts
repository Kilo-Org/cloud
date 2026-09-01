import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parsePatchFiles, type SelectedLineRange } from '@pierre/diffs';
import type { WorktreeFileRecord } from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import type { WorktreeReviewCapture, WorktreeReviewComment } from './worktree-review';
import type { WorktreeReviewDiffProps } from './WorktreeReviewEditor';
import type { WorktreeFileReviewBindings } from './worktree-review-bindings';

const require = createRequire(import.meta.url);
const {
  formatWorktreeReviewRange,
  getWorktreeReviewAnnotations,
}: typeof import('./worktree-review-bindings') = require('./worktree-review-bindings');
const {
  WorktreeReviewEditor,
}: typeof import('./WorktreeReviewEditor') = require('./WorktreeReviewEditor');

const {
  bindWorktreeReviewSelection,
  readWorktreeReviewTextSelection,
  validateWorktreeReviewRenderedRange,
}: typeof import('./worktree-review-selection') = require('./worktree-review-selection');

class TestNode {
  nodeType = 3;
  childNodes: TestNode[] = [];
  parentNode: TestNode | null = null;
  constructor(private text = '') {}
  get parentElement(): TestElement | null {
    return this.parentNode instanceof TestElement ? this.parentNode : null;
  }
  get previousSibling(): TestNode | null {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) - 1] ?? null;
  }
  get textContent(): string {
    return this.text + this.childNodes.map(node => node.textContent).join('');
  }
  getRootNode(): TestNode {
    return this.parentNode?.getRootNode() ?? this;
  }
  append(...nodes: TestNode[]) {
    for (const node of nodes) {
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
}

class TestElement extends TestNode {
  nodeType = 1;
  attributes = new Map<string, string>();
  constructor(
    readonly tagName = 'div',
    attributes: Record<string, string> = {}
  ) {
    super();
    for (const [name, value] of Object.entries(attributes)) this.setAttribute(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  get tabIndex() {
    return Number(this.getAttribute('tabindex') ?? -1);
  }
  set tabIndex(value: number) {
    this.setAttribute('tabindex', String(value));
  }
  matches(selector: string): boolean {
    return selector.split(',').some(part => {
      const segments = part.trim().split(/\s*>\s*/);
      let element: TestElement | null = this;
      for (const segment of segments.reverse()) {
        if (!element) return false;
        const tag = segment.match(/^[a-z]+/)?.[0];
        if (tag && tag !== element.tagName) return false;
        for (const [, attribute] of segment.matchAll(/\[([^\]]+)\]/g)) {
          if (!element.attributes.has(attribute)) return false;
        }
        element = element.parentElement;
      }
      return true;
    });
  }
  closest(selector: string): TestElement | null {
    return this.matches(selector) ? this : (this.parentElement?.closest(selector) ?? null);
  }
  focus() {
    const root = this.getRootNode();
    if (root instanceof TestRoot) {
      root.activeElement = this;
      root.events.emit('focusin', { target: this });
    }
  }
  scrollIntoView() {}
}

class TestListeners {
  listeners = new Map<string, Set<(event: never) => void>>();
  addEventListener = (type: string, listener: (event: never) => void) => {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  };
  removeEventListener = (type: string, listener: (event: never) => void) => {
    this.listeners.get(type)?.delete(listener);
  };
  emit(type: string, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
  get size() {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
}

class TestKeyEvent {
  defaultPrevented = false;
  altKey = false;
  ctrlKey = false;
  metaKey = false;
  constructor(
    readonly target: TestElement,
    readonly key: string,
    readonly shiftKey = false
  ) {}
  preventDefault() {
    this.defaultPrevented = true;
  }
}

class TestRoot extends TestNode {
  host = { isConnected: true };
  activeElement: TestElement | null = null;
  selection: Parameters<typeof readWorktreeReviewTextSelection>[1] = null;
  events = new TestListeners();
  documentEvents = new TestListeners();
  ownerDocument = {
    defaultView: { HTMLElement: TestElement, KeyboardEvent: TestKeyEvent },
    getSelection: () => this.selection,
    addEventListener: this.documentEvents.addEventListener,
    removeEventListener: this.documentEvents.removeEventListener,
  };
  addEventListener = this.events.addEventListener;
  removeEventListener = this.events.removeEventListener;
  querySelectorAll(selector: string): TestElement[] {
    const elements: TestElement[] = [];
    const visit = (node: TestNode) => {
      if (node instanceof TestElement && node.matches(selector)) elements.push(node);
      node.childNodes.forEach(visit);
    };
    this.childNodes.forEach(visit);
    return elements;
  }
  get dom(): ShadowRoot {
    return this as unknown as ShadowRoot;
  }
}

function renderedRows(
  lines: Array<[number, string]> = [
    [41, 'context'],
    [42, 'change-addition'],
    [43, 'change-addition'],
  ]
) {
  const root = new TestRoot();
  const code = new TestElement('code', { 'data-code': '', 'data-unified': '' });
  const content = new TestElement('div', { 'data-content': '' });
  root.append(code);
  code.append(content);
  const rows = lines.map(([line, type], index) => {
    const row = new TestElement('div', {
      'data-line': String(line),
      'data-line-type': type,
      'data-line-index': `${index},${index}`,
    });
    const token = new TestElement('span');
    token.append(new TestNode('source\n'));
    row.append(token);
    content.append(row);
    return row;
  });
  function select(start: TestNode, end: TestNode, startOffset = 0, endOffset = 1, composed = true) {
    const range = {
      startContainer: start,
      endContainer: end,
      startOffset,
      endOffset,
    } as unknown as Range;
    root.selection = {
      rangeCount: 1,
      getRangeAt: () => range,
      ...(composed
        ? {
            getComposedRanges: ({ shadowRoots }: { shadowRoots: ShadowRoot[] }) => {
              assert.deepEqual(shadowRoots, [root.dom]);
              return [range];
            },
          }
        : {}),
    };
    return readWorktreeReviewTextSelection(root.dom);
  }
  return { root, rows, content, select };
}

const capture: WorktreeReviewCapture = {
  userId: 'user-one',
  organizationId: undefined,
  workspaceScope: 'worktree-one',
  sourceCloudAgentSessionId: 'workspace_one',
  revision: 3,
  capturedAt: '2026-09-01T10:00:00Z',
  comparison: {
    baseRef: 'refs/remotes/origin/main',
    mergeBase: 'a'.repeat(40),
    head: 'b'.repeat(40),
  },
};

function comment(id: string, startLine = 4): WorktreeReviewComment {
  return {
    id,
    anchor: {
      capture,
      path: 'src/example.ts',
      range: { side: 'additions', startLine, endLine: 5 },
      quote: {
        source: 'saved-patch',
        lines: Array.from({ length: 6 - startLine }, (_, index) => ({
          lineNumber: startLine + index,
          kind: 'addition',
          text: 'saved source\n',
        })),
      },
    },
    text: 'Please simplify this.',
  };
}

describe('worktree review renderer annotations', () => {
  it('groups ranges at the same side and end line into one native slot without changing comments', () => {
    const first = comment('first');
    const second = comment('second', 5);
    const comments = Object.freeze([first, second]);
    const annotations = getWorktreeReviewAnnotations(comments, capture, first.anchor.path);
    assert.deepEqual(annotations, [
      { side: 'additions', lineNumber: 5, metadata: [first, second] },
    ]);
    assert.equal(annotations[0]?.metadata[0]?.anchor, first.anchor);
    assert.equal(first.anchor.range.startLine, 4);
  });

  it('keeps old and new sides at the same line in distinct annotation slots', () => {
    const added = comment('added');
    const deleted = comment('deleted');
    deleted.anchor.range.side = 'deletions';
    const annotations = getWorktreeReviewAnnotations([added, deleted], capture, added.anchor.path);
    assert.deepEqual(
      annotations.map(({ side, lineNumber }) => ({ side, lineNumber })),
      [
        { side: 'additions', lineNumber: 5 },
        { side: 'deletions', lineNumber: 5 },
      ]
    );
  });

  const otherCaptures: Record<string, WorktreeReviewCapture> = {
    user: { ...capture, userId: 'other' },
    organization: { ...capture, organizationId: 'other' },
    worktree: { ...capture, workspaceScope: 'other' },
    source: { ...capture, sourceCloudAgentSessionId: 'workspace_other' },
    revision: { ...capture, revision: 4 },
    timestamp: { ...capture, capturedAt: '2026-09-01T10:01:00Z' },
    baseRef: { ...capture, comparison: { ...capture.comparison, baseRef: 'origin/other' } },
    mergeBase: { ...capture, comparison: { ...capture.comparison, mergeBase: 'c'.repeat(40) } },
    head: { ...capture, comparison: { ...capture.comparison, head: 'c'.repeat(40) } },
  };
  for (const [field, current] of Object.entries(otherCaptures)) {
    it(`does not attach comments when the displayed ${field} differs`, () => {
      const saved = comment('saved');
      assert.deepEqual(getWorktreeReviewAnnotations([saved], current, saved.anchor.path), []);
      assert.equal(saved.anchor.quote.lines[0]?.text, 'saved source\n');
    });
  }

  it('does not attach a comment from a different file in the same capture', () => {
    assert.deepEqual(getWorktreeReviewAnnotations([comment('saved')], capture, 'other.ts'), []);
  });

  it('shows the whole reviewed range although its annotation sits at the end', () => {
    assert.equal(
      formatWorktreeReviewRange({ side: 'deletions', startLine: 4, endLine: 9 }),
      'Old lines 4–9'
    );
    assert.equal(
      formatWorktreeReviewRange({ side: 'additions', startLine: 5, endLine: 5 }),
      'New line 5'
    );
  });
});

describe('worktree review rendered selection', () => {
  it('uses composed ranges and file coordinates, including unified context and nested tokens', () => {
    const { root, rows, select } = renderedRows();
    const first = rows[0].childNodes[0].childNodes[0];
    const last = rows[2].childNodes[0].childNodes[0];
    const result = select(first, last, 2, 3);
    assert.deepEqual(result, { ok: true, value: { side: 'additions', start: 41, end: 43 } });
    assert.ok(root.selection);
    root.selection.getRangeAt = () => assert.fail('Composed selection must take precedence.');
    assert.deepEqual(readWorktreeReviewTextSelection(root.dom), result);
  });

  it('excludes an end boundary at the beginning of a nested token, including backwards selections', () => {
    const { rows, select } = renderedRows();
    const last = rows[2].childNodes[0].childNodes[0];
    assert.deepEqual(select(rows[0], last, 0, 0), {
      ok: true,
      value: { side: 'additions', start: 41, end: 42 },
    });
    assert.deepEqual(select(rows[0], rows[2], 0, 0, false), {
      ok: true,
      value: { side: 'additions', start: 41, end: 42 },
    });
  });

  it('accepts only in-root fallback ranges and does not rescue a cross-file composed range', () => {
    const { root, rows, select } = renderedRows();
    const expected = select(rows[0], rows[1], 0, 1, false);
    const inRoot = root.selection;
    Object.assign(root, { getSelection: () => inRoot });
    root.selection = {
      rangeCount: 0,
      getRangeAt: () => assert.fail('Use the shadow-root selection.'),
    };
    assert.deepEqual(readWorktreeReviewTextSelection(root.dom), expected);
    const other = renderedRows();
    select(rows[0], other.rows[1]);
    assert.deepEqual(readWorktreeReviewTextSelection(root.dom), { ok: true, value: null });
  });

  it('does not exclude offset zero in a later token and maps a blank line', () => {
    const { rows, select } = renderedRows();
    const nextToken = new TestElement('span');
    const nextText = new TestNode('second');
    nextToken.append(nextText);
    rows[2].append(nextToken);
    assert.deepEqual(select(rows[1], nextText, 0, 0), {
      ok: true,
      value: { side: 'additions', start: 42, end: 43 },
    });
    rows[1].childNodes = [];
    const blank = new TestNode('\n');
    rows[1].append(blank);
    assert.deepEqual(select(blank, blank, 0, 1), {
      ok: true,
      value: { side: 'additions', start: 42, end: 42 },
    });
  });

  it('rejects mixed interior sides even when both endpoints are new lines', () => {
    const { root, rows, select } = renderedRows([
      [1, 'context'],
      [2, 'change-deletion'],
      [2, 'change-addition'],
    ]);
    const result = select(rows[0], rows[2]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /not both/);
    assert.equal(
      validateWorktreeReviewRenderedRange(root.dom, { side: 'additions', start: 1, end: 2 }).ok,
      false
    );
    assert.deepEqual(
      validateWorktreeReviewRenderedRange(root.dom, { side: 'deletions', start: 2, end: 2 }),
      {
        ok: true,
        value: { side: 'deletions', start: 2, end: 2 },
      }
    );
  });

  it('rejects hidden gaps, unavailable endpoints, invalid coordinates, and oversized ranges', () => {
    const { root, rows, select } = renderedRows([
      [4, 'context'],
      [9, 'context'],
    ]);
    assert.equal(select(rows[0], rows[1]).ok, false);
    assert.equal(
      validateWorktreeReviewRenderedRange(root.dom, { side: 'additions', start: 4, end: 10 }).ok,
      false
    );
    assert.equal(
      validateWorktreeReviewRenderedRange(root.dom, { side: 'additions', start: 0, end: 9 }).ok,
      false
    );
    const large = renderedRows(Array.from({ length: 101 }, (_, index) => [index + 1, 'context']));
    assert.equal(large.select(large.rows[0], large.rows[100]).ok, false);
  });

  it('ignores out-of-scope, annotation, separator, gutter, collapsed, and detached selections', () => {
    const { root, rows, content, select } = renderedRows();
    const other = renderedRows();
    assert.deepEqual(select(rows[0], other.rows[1]), { ok: true, value: null });
    for (const attribute of [
      'data-line-annotation',
      'data-separator',
      'data-gutter-utility-slot',
    ]) {
      const excluded = new TestElement('div', { [attribute]: '' });
      excluded.append(new TestNode('not source'));
      content.append(excluded);
      assert.deepEqual(select(rows[0], excluded.childNodes[0]), { ok: true, value: null });
    }
    const button = new TestElement('button');
    rows[0].append(button);
    assert.deepEqual(select(button, rows[1]), { ok: true, value: null });
    assert.deepEqual(select(rows[0], rows[0], 0, 0), { ok: true, value: null });
    root.host.isConnected = false;
    assert.deepEqual(select(rows[0], rows[1]), { ok: true, value: null });
    assert.deepEqual(other.select(rows[0], rows[1], 0, 1, false), { ok: true, value: null });
  });

  it('keeps gutter touch targets focusable without adding tab stops and restores their attributes', () => {
    const { root, rows, content } = renderedRows();
    const gutter = new TestElement('div', { 'data-gutter': '' });
    const first = new TestElement('div', { 'data-column-number': '41' });
    const second = new TestElement('div', { 'data-column-number': '42', tabindex: '2' });
    gutter.append(first, second);
    content.parentElement?.append(gutter);
    const cleanup = bindWorktreeReviewSelection(
      root.dom,
      () => {},
      () => {}
    );
    assert.equal(first.tabIndex, -1);
    assert.equal(second.tabIndex, -1);
    assert.equal([...rows, first, second].filter(row => row.tabIndex === 0).length, 1);
    cleanup();
    assert.equal(first.getAttribute('tabindex'), null);
    assert.equal(second.getAttribute('tabindex'), '2');
  });

  it('keeps copy and touch selection passive, provides one keyboard entry, and cleans listeners', () => {
    const { root, rows, select } = renderedRows();
    const selected: Array<ReturnType<typeof readWorktreeReviewTextSelection>> = [];
    const comments: SelectedLineRange[] = [];
    const cleanup = bindWorktreeReviewSelection(
      root.dom,
      result => selected.push(result),
      range => comments.push(range)
    );
    assert.deepEqual(
      rows.map(row => row.tabIndex),
      [0, -1, -1]
    );
    select(rows[0], rows[1]);
    const nativeSelection = root.selection;
    root.documentEvents.emit('selectionchange');
    assert.equal(root.selection, nativeSelection);
    assert.equal(root.activeElement, null);
    assert.equal(comments.length, 0);
    root.selection = null;
    root.documentEvents.emit('selectionchange');
    const down = new TestKeyEvent(rows[0], 'ArrowDown', true);
    root.events.emit('keydown', down);
    assert.equal(down.defaultPrevented, true);
    assert.deepEqual(
      rows.map(row => row.tabIndex),
      [-1, 0, -1]
    );
    assert.equal(root.activeElement, rows[1]);
    root.events.emit('keydown', new TestKeyEvent(rows[1], 'Enter'));
    assert.deepEqual(comments, [{ side: 'additions', start: 41, end: 42 }]);
    root.events.emit('keydown', new TestKeyEvent(rows[1], 'Escape'));
    assert.deepEqual(selected.at(-1), { ok: true, value: null });
    const copy = new TestKeyEvent(rows[1], 'c');
    copy.ctrlKey = true;
    root.events.emit('keydown', copy);
    assert.equal(copy.defaultPrevented, false);
    const input = new TestKeyEvent(new TestElement('textarea'), 'Enter');
    root.events.emit('keydown', input);
    assert.equal(input.defaultPrevented, false);
    const count = selected.length;
    cleanup();
    cleanup();
    assert.equal(root.events.size, 0);
    assert.equal(root.documentEvents.size, 0);
    assert.deepEqual(
      rows.map(row => row.getAttribute('tabindex')),
      [null, null, null]
    );
    root.events.emit('keydown', new TestKeyEvent(rows[0], 'Enter'));
    root.documentEvents.emit('selectionchange');
    assert.equal(selected.length, count);
    assert.equal(comments.length, 1);
  });

  it('does not turn invalid keyboard extensions into a single-line comment', () => {
    const { root, rows } = renderedRows([
      [1, 'context'],
      [2, 'change-deletion'],
      [2, 'change-addition'],
    ]);
    const comments: SelectedLineRange[] = [];
    const cleanup = bindWorktreeReviewSelection(
      root.dom,
      () => {},
      range => comments.push(range)
    );
    root.events.emit('keydown', new TestKeyEvent(rows[0], 'ArrowDown', true));
    root.events.emit('keydown', new TestKeyEvent(rows[1], 'ArrowDown', true));
    root.events.emit('keydown', new TestKeyEvent(rows[2], 'Enter'));
    assert.deepEqual(comments, []);
    cleanup();
  });
});

describe('worktree review rendering readiness', () => {
  const patch =
    'diff --git a/src/example.ts b/src/example.ts\nindex 1234567..abcdef0 100644\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,5 +1,5 @@\n first\n second\n third\n-old four\n-old five\n+saved source\n+saved source\n';
  const file: WorktreeFileRecord = {
    schemaVersion: 1,
    revision: capture.revision,
    path: 'src/example.ts',
    diff: { status: 'available', patch },
    content: { status: 'unavailable', reason: 'too_large' },
  };
  const diff = parsePatchFiles(patch, undefined, true)[0]?.files[0];
  assert.ok(diff);

  function renderReview(
    renderStatus: 'loading' | 'ready' | 'error',
    editor: WorktreeFileReviewBindings['editor'] = null,
    onEditorChange: WorktreeFileReviewBindings['onEditorChange'] = () => {
      assert.fail('Rendering must not replace a retained editor.');
    },
    displayedFile = file
  ) {
    const saved = comment('saved');
    const review: WorktreeFileReviewBindings = Object.freeze({
      comments: Object.freeze([saved]),
      editor,
      onEditorChange,
      onSaveEditor() {
        assert.fail('Rendering must not save comments.');
      },
      onRemoveComment() {
        assert.fail('Rendering must not remove comments.');
      },
    });
    const emitted: WorktreeReviewDiffProps[] = [];
    const markup = renderToStaticMarkup(
      createElement(WorktreeReviewEditor, {
        file: displayedFile,
        diff,
        capture,
        review,
        renderStatus,
        children(props) {
          emitted.push(props);
          return null;
        },
      })
    );
    const props = emitted[0];
    assert.ok(props);
    assert.equal(review.editor, editor);
    assert.equal(review.disabledReason, undefined);
    assert.equal(saved.anchor.quote.lines[0]?.text, 'saved source\n');
    return { props, markup };
  }

  for (const status of ['loading', 'error'] as const) {
    it(`blocks new anchors while ${status}, but retains annotations and edit/remove actions`, () => {
      const { props, markup } = renderReview(status);
      assert.equal(props.options?.enableLineSelection, false);
      assert.equal(props.options?.enableGutterUtility, false);
      assert.equal(props.renderGutterUtility, undefined);
      assert.match(markup, /aria-disabled="true"/);
      const annotation = props.lineAnnotations?.[0];
      assert.ok(annotation);
      const card = renderToStaticMarkup(props.renderAnnotation?.(annotation));
      assert.match(card, />Edit<\/button>/);
      assert.match(card, />Remove<\/button>/);
      assert.doesNotMatch(card, /disabled=""/);
    });
  }

  it('enables saved-hunk comments after readiness even without full content', () => {
    const { props, markup } = renderReview('ready');
    assert.equal(props.options?.enableLineSelection, true);
    assert.equal(props.options?.enableGutterUtility, false);
    assert.equal(props.renderGutterUtility, undefined);
    assert.equal(props.options?.onLineNumberClick, undefined);
    assert.match(markup, /aria-disabled="true"/);
    assert.match(markup, /select code and choose Comment/);
    assert.match(markup, /min-h-11/);
    assert.doesNotMatch(
      markup,
      /type="number"|inputmode="numeric"|Start line|End line|Use selected lines|role="combobox"/
    );
    assert.equal(props.options?.onLineSelected, undefined);
    assert.equal(props.options?.onGutterUtilityClick, undefined);
    assert.equal(typeof props.options?.onLineSelectionStart, 'function');
    assert.equal(typeof props.options?.onLineSelectionChange, 'function');
    assert.equal(typeof props.options?.onLineSelectionEnd, 'function');
    assert.equal(typeof props.options?.onPostRender, 'function');
  });

  it('opens feedback once on native completion and quotes saved source, never rendered text', () => {
    const editors: WorktreeFileReviewBindings['editor'][] = [];
    const { props } = renderReview('ready', null, editor => editors.push(editor));
    const { root } = renderedRows([
      [4, 'change-addition'],
      [5, 'change-addition'],
    ]);
    const node = { shadowRoot: root.dom } as HTMLElement;
    const instance = {} as import('@pierre/diffs').FileDiff<WorktreeReviewComment[]>;
    props.options?.onPostRender?.(node, instance, 'mount');
    const range: SelectedLineRange = { side: 'additions', start: 5, end: 4 };
    props.options?.onLineSelectionStart?.(range);
    props.options?.onLineSelectionChange?.(range);
    props.options?.onLineSelected?.(range);
    assert.equal(editors.length, 0);
    props.options?.onLineSelectionEnd?.(range);
    props.options?.onLineSelectionEnd?.(range);
    assert.equal(editors.length, 1);
    assert.deepEqual(editors[0]?.anchor.range, { side: 'additions', startLine: 4, endLine: 5 });
    assert.deepEqual(editors[0]?.anchor.capture, capture);
    assert.deepEqual(
      editors[0]?.anchor.quote.lines.map(line => line.text),
      ['saved source\n', 'saved source\n']
    );
    props.options?.onPostRender?.(node, instance, 'unmount');
  });

  it('opens a single old line through completion without a competing gutter click handler', () => {
    const editors: WorktreeFileReviewBindings['editor'][] = [];
    const { props } = renderReview('ready', null, editor => editors.push(editor));
    const { root } = renderedRows([
      [4, 'change-deletion'],
      [5, 'change-deletion'],
    ]);
    const node = { shadowRoot: root.dom } as HTMLElement;
    const instance = {} as import('@pierre/diffs').FileDiff<WorktreeReviewComment[]>;
    props.options?.onPostRender?.(node, instance, 'mount');
    props.options?.onLineSelectionEnd?.(null);
    assert.equal(editors.length, 0);
    assert.equal(props.options?.onLineNumberClick, undefined);
    assert.equal(props.options?.enableGutterUtility, false);
    const range: SelectedLineRange = { side: 'deletions', start: 4, end: 4 };
    props.options?.onLineSelectionEnd?.(range);
    props.options?.onLineSelectionEnd?.(range);
    assert.equal(editors.length, 1);
    assert.deepEqual(editors[0]?.anchor.range, { side: 'deletions', startLine: 4, endLine: 4 });
    props.options?.onPostRender?.(node, instance, 'unmount');
  });

  it('rebinds the DOM bridge without duplicate listeners and retires stale capture handlers', () => {
    const editors: WorktreeFileReviewBindings['editor'][] = [];
    const { props } = renderReview('ready', null, editor => editors.push(editor));
    const first = renderedRows([
      [4, 'change-addition'],
      [5, 'change-addition'],
    ]);
    const second = renderedRows([
      [4, 'change-addition'],
      [5, 'change-addition'],
    ]);
    const instance = {} as import('@pierre/diffs').FileDiff<WorktreeReviewComment[]>;
    const node = { shadowRoot: first.root.dom } as HTMLElement;
    props.options?.onPostRender?.(node, instance, 'mount');
    const listenerCount = first.root.events.size;
    assert.ok(listenerCount > 0);
    props.options?.onPostRender?.(node, instance, 'update');
    assert.equal(first.root.events.size, listenerCount);
    assert.equal(first.root.documentEvents.size, 1);
    const nextNode = { shadowRoot: second.root.dom } as HTMLElement;
    props.options?.onPostRender?.(nextNode, instance, 'update');
    assert.equal(first.root.events.size, 0);
    assert.equal(first.root.documentEvents.size, 0);
    first.root.events.emit('keydown', new TestKeyEvent(first.rows[0], 'Enter'));
    assert.equal(editors.length, 0);
    props.options?.onPostRender?.(nextNode, instance, 'unmount');
    assert.equal(second.root.events.size, 0);
    assert.equal(second.root.documentEvents.size, 0);
    props.options?.onLineSelectionEnd?.({ side: 'additions', start: 4, end: 5 });
    assert.equal(editors.length, 0);
  });

  it('does not open an anchor when the saved file revision no longer matches the capture', () => {
    const editors: WorktreeFileReviewBindings['editor'][] = [];
    const { props } = renderReview('ready', null, editor => editors.push(editor), {
      ...file,
      revision: capture.revision + 1,
    });
    const { root } = renderedRows([
      [4, 'change-addition'],
      [5, 'change-addition'],
    ]);
    const node = { shadowRoot: root.dom } as HTMLElement;
    const instance = {} as import('@pierre/diffs').FileDiff<WorktreeReviewComment[]>;
    props.options?.onPostRender?.(node, instance, 'mount');
    props.options?.onLineSelectionEnd?.({ side: 'additions', start: 4, end: 5 });
    assert.equal(editors.length, 0);
    props.options?.onPostRender?.(node, instance, 'unmount');
  });

  it('never replaces pending feedback or creates anchors for binary files', () => {
    const saved = comment('pending');
    const editor = { anchor: saved.anchor, text: 'Keep this feedback' };
    const retained = renderReview('ready', editor);
    const { root } = renderedRows([
      [4, 'change-addition'],
      [5, 'change-addition'],
    ]);
    const node = { shadowRoot: root.dom } as HTMLElement;
    const instance = {} as import('@pierre/diffs').FileDiff<WorktreeReviewComment[]>;
    retained.props.options?.onPostRender?.(node, instance, 'mount');
    retained.props.options?.onLineSelectionEnd?.({ side: 'additions', start: 4, end: 5 });
    assert.equal(editor.text, 'Keep this feedback');
    assert.equal(root.documentEvents.size, 0);
    retained.props.options?.onPostRender?.(node, instance, 'unmount');
    const binary = renderReview('ready', editor, undefined, {
      ...file,
      content: { status: 'unavailable', reason: 'binary' },
    });
    assert.equal(binary.props.options?.enableLineSelection, false);
    assert.equal(binary.props.renderGutterUtility, undefined);
    assert.match(binary.markup, /Binary files/);
    assert.match(binary.markup, /Continue comment/);
  });

  it('keeps an older editor reachable with its exact quote after rendering fails', () => {
    const saved = comment('old');
    saved.anchor.capture = { ...capture, revision: capture.revision - 1 };
    const editor = Object.freeze({ anchor: saved.anchor, text: 'Unsaved feedback' });
    const { props, markup } = renderReview('error', editor);
    assert.equal(props.options?.enableLineSelection, false);
    assert.match(markup, /Continue comment/);
    assert.equal(editor.anchor.capture.revision, capture.revision - 1);
    assert.equal(editor.text, 'Unsaved feedback');
  });
});
