// @vitest-environment jsdom
/* eslint-disable id-length, jest/no-conditional-expect, jest/no-conditional-in-test, jest/prefer-strict-equal, max-lines, no-new-func, require-await, typescript/no-implied-eval, typescript/no-unsafe-call, typescript-eslint/no-base-to-string, typescript-eslint/no-unsafe-type-assertion, typescript-eslint/require-await, unicorn/prefer-array-find, vitest/prefer-describe-function-title -- Fake CDP session records verbatim commands and runs the page-side function strings against the jsdom document; assertions check conditional error branches. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  INTERACT_BROWSER_TOOL_NAMES,
  isInteractBrowserToolName,
  runInteractBrowserTool,
} from './browser-tool-interact-actions';
import type { BrowserToolInteractSession } from './browser-tool-interact-actions';
import type { BrowserToolResolvedTarget } from './browser-tool-session';

/** A field attached to the document: what a fresh snapshot ref resolves to. */
const attachedField = (): Element => {
  const field = document.createElement('input');
  document.body.append(field);

  return field;
};

/** Runs a `Runtime.callFunctionOn` declaration the way the page does: `this` is the node. */
const callOnNode = (node: Element, declaration: string, args: unknown[]): unknown =>
  (
    new Function('ShadowRoot', `return (${declaration});`)(globalThis.ShadowRoot) as (
      ...values: unknown[]
    ) => unknown
  ).apply(node, args);

interface RecordedCommand {
  readonly method: string;
  readonly params: Record<string, unknown> | undefined;
}

const REF_BOX = [10, 20, 30, 20, 30, 40, 10, 40];
const END_BOX = [110, 220, 130, 220, 130, 240, 110, 240];

interface FakePageHelperEnvelope {
  readonly error?: string;
  readonly ok: boolean;
  readonly result?: unknown;
}

const createFakeSession = ({
  boxModelError,
  boxes = {},
  node = attachedField(),
  pageHelper,
  resolveNodeError,
  targets = {},
}: {
  /** A CDP rejection, as when the ref's node was removed without a navigation. */
  boxModelError?: string;
  boxes?: Record<number, number[]>;
  /** The node `DOM.resolveNode` hands back; `Runtime.callFunctionOn` runs on it. */
  node?: Element;
  pageHelper?: FakePageHelperEnvelope | ((expression: string) => FakePageHelperEnvelope);
  /** A CDP rejection while resolving the ref's node to a remote object. */
  resolveNodeError?: string;
  targets?: Record<string, BrowserToolResolvedTarget>;
} = {}): { commands: RecordedCommand[]; session: BrowserToolInteractSession } => {
  const commands: RecordedCommand[] = [];

  const session: BrowserToolInteractSession = {
    resolveTarget: async (target: string) => targets[target],
    send: async (method, params) => {
      commands.push({ method, params });

      if (method === 'DOM.getBoxModel') {
        if (boxModelError !== undefined) {
          throw new Error(boxModelError);
        }

        const backendNodeId = params?.['backendNodeId'];
        const nodeId = params?.['nodeId'];
        const box =
          (typeof backendNodeId === 'number' ? boxes[backendNodeId] : undefined) ??
          (typeof nodeId === 'number' ? boxes[nodeId] : undefined) ??
          REF_BOX;

        return { model: { content: box } };
      }

      if (method === 'DOM.pushNodesByBackendIdsToFrontend') {
        // What Chrome answers in a session that never sent `DOM.getDocument`, which a snapshot never does.
        throw new Error('Document needs to be requested first');
      }

      if (method === 'DOM.resolveNode') {
        if (resolveNodeError !== undefined) {
          throw new Error(resolveNodeError);
        }

        return { object: { objectId: 'kilo-node-object' } };
      }

      if (method === 'Runtime.callFunctionOn') {
        const args = (params?.['arguments'] as readonly { value: unknown }[] | undefined) ?? [];
        const value = callOnNode(
          node,
          String(params?.['functionDeclaration'] ?? ''),
          args.map(arg => arg.value)
        );

        return { result: value === undefined ? {} : { value } };
      }

      if (method === 'Runtime.evaluate') {
        const expression = String(params?.['expression'] ?? '');
        const envelope =
          typeof pageHelper === 'function'
            ? pageHelper(expression)
            : (pageHelper ?? { ok: true, result: true });

        return {
          result: {
            value: {
              dryRunActions: [],
              ok: envelope.ok,
              ...(envelope.error === undefined ? {} : { error: envelope.error }),
              ...(envelope.ok ? { value: { done: true, result: envelope.result } } : {}),
            },
          },
        };
      }

      return {};
    },
  };

  return { commands, session };
};

/** A ref error must name no tool: the side panel and the CLI call the snapshot tool by different names. */
const expectFreshSnapshotHint = (error: string): void => {
  expect(error).toContain('Take a new page snapshot and use a ref from it');
  expect(error).not.toMatch(/kilo_browser_|browser_snapshot/u);
};

const ref = (backendNodeId: number): BrowserToolResolvedTarget => ({
  backendNodeId,
  kind: 'ref',
  ref: `e${String(backendNodeId)}`,
});

const selector = (nodeId: number, css: string): BrowserToolResolvedTarget => ({
  kind: 'selector',
  nodeId,
  selector: css,
});

const mouseEvents = (commands: RecordedCommand[]): Record<string, unknown>[] =>
  commands
    .filter(command => command.method === 'Input.dispatchMouseEvent')
    .map(command => command.params ?? {});

const keyEvents = (commands: RecordedCommand[]): Record<string, unknown>[] =>
  commands
    .filter(command => command.method === 'Input.dispatchKeyEvent')
    .map(command => command.params ?? {});

describe('isInteractBrowserToolName', () => {
  it('accepts the upstream and kilo_ names of every interaction tool', () => {
    for (const name of INTERACT_BROWSER_TOOL_NAMES) {
      expect(isInteractBrowserToolName(name)).toBe(true);
      expect(isInteractBrowserToolName(`kilo_${name}`)).toBe(true);
    }
    expect(isInteractBrowserToolName('browser_navigate')).toBe(false);
  });
});

describe('browser_click', () => {
  it('scrolls, resolves the ref centre, and presses and releases the left button', async () => {
    const { commands, session } = createFakeSession({ targets: { e70: ref(70) } });

    const result = await runInteractBrowserTool(
      'browser_click',
      { element: 'Sign in', target: 'e70' },
      session
    );

    expect(result).toEqual({ ok: true, value: 'Clicked "Sign in" with the left button.' });
    expect(commands.map(command => command.method)).toEqual([
      'DOM.scrollIntoViewIfNeeded',
      'DOM.getBoxModel',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
    ]);
    const [pressed, released] = mouseEvents(commands);
    expect(pressed).toMatchObject({ button: 'left', type: 'mousePressed', x: 20, y: 30 });
    expect(released).toMatchObject({ button: 'left', type: 'mouseReleased', x: 20, y: 30 });
  });

  it('uses the box model centre directly, since getBoxModel is viewport-relative', async () => {
    const { commands, session } = createFakeSession({ targets: { e70: ref(70) } });

    await runInteractBrowserTool('browser_click', { target: 'e70' }, session);

    expect(commands.map(command => command.method)).not.toContain('Page.getLayoutMetrics');
    const [pressed] = mouseEvents(commands);
    expect(pressed).toMatchObject({ type: 'mousePressed', x: 20, y: 30 });
  });

  it('resolves a unique CSS selector target', async () => {
    const { commands, session } = createFakeSession({ targets: { '#go': selector(5, '#go') } });

    const result = await runInteractBrowserTool('browser_click', { target: '#go' }, session);

    expect(result.ok).toBe(true);
    expect(commands.some(command => command.method === 'DOM.getBoxModel')).toBe(true);
  });

  it('double clicks with the second pair at clickCount 2', async () => {
    const { commands, session } = createFakeSession({ targets: { e70: ref(70) } });

    await runInteractBrowserTool('browser_click', { doubleClick: true, target: 'e70' }, session);

    const presses = mouseEvents(commands).filter(event => event['type'] === 'mousePressed');
    expect(presses.map(event => event['clickCount'])).toEqual([1, 2]);
  });

  it('applies modifier bits and the requested button', async () => {
    const { commands, session } = createFakeSession({ targets: { e70: ref(70) } });

    await runInteractBrowserTool(
      'browser_click',
      { button: 'right', modifiers: ['Alt', 'Shift'], target: 'e70' },
      session
    );

    const [pressed] = mouseEvents(commands);
    expect(pressed).toMatchObject({ button: 'right', modifiers: 9 });
  });

  it('reports a stale or unknown ref with the fresh-snapshot hint', async () => {
    const { session } = createFakeSession();

    const result = await runInteractBrowserTool('browser_click', { target: 'e404' }, session);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('stale or unknown');
      expectFreshSnapshotHint(result.error);
    }
  });

  it('reports a selector that matches several elements', async () => {
    const { session } = createFakeSession({
      targets: {
        '#many': { kind: 'ambiguous', matches: 3, selector: '#many' },
      },
    });

    const result = await runInteractBrowserTool('browser_click', { target: '#many' }, session);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(
        'The selector matches 3 elements. Use a snapshot ref or a selector that matches one element.'
      );
    }
  });

  it('reports a stale ref when the node is gone before the box model call', async () => {
    const { session } = createFakeSession({
      boxModelError: 'Could not find node with given id',
      targets: { e70: ref(70) },
    });

    const result = await runInteractBrowserTool('browser_click', { target: 'e70' }, session);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('stale or unknown');
      expectFreshSnapshotHint(result.error);
    }
  });

  it('reports an unmatched selector', async () => {
    const { session } = createFakeSession();

    const result = await runInteractBrowserTool('browser_click', { target: '#missing' }, session);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('No element matches the selector "#missing"');
    }
  });
});

describe('browser_hover', () => {
  it('moves the mouse onto the element centre', async () => {
    const { commands, session } = createFakeSession({ targets: { e70: ref(70) } });

    const result = await runInteractBrowserTool('browser_hover', { target: 'e70' }, session);

    expect(result.ok).toBe(true);
    const [moved] = mouseEvents(commands);
    expect(moved).toMatchObject({ button: 'none', type: 'mouseMoved', x: 20, y: 30 });
  });
});

describe('browser_drag', () => {
  it('presses, moves in steps, and releases between the two targets', async () => {
    const { commands, session } = createFakeSession({
      boxes: { 1: REF_BOX, 2: END_BOX },
      targets: { e1: ref(1), e2: ref(2) },
    });

    const result = await runInteractBrowserTool(
      'browser_drag',
      { endTarget: 'e2', startTarget: 'e1' },
      session
    );

    expect(result.ok).toBe(true);
    const events = mouseEvents(commands);
    expect(events[0]).toMatchObject({ type: 'mouseMoved', x: 20, y: 30 });
    expect(events[1]).toMatchObject({ buttons: 1, type: 'mousePressed', x: 20, y: 30 });
    expect(events.filter(event => event['type'] === 'mouseMoved')).toHaveLength(5);
    expect(events.at(-1)).toMatchObject({ type: 'mouseReleased', x: 120, y: 230 });
  });
});

describe('browser_drop', () => {
  it('rejects a drop with neither paths nor data using the upstream wording', async () => {
    const { session } = createFakeSession({ targets: { e70: ref(70) } });

    const result = await runInteractBrowserTool('browser_drop', { target: 'e70' }, session);

    expect(result).toEqual({
      error: 'At least one of "paths" or "data" must be provided.',
      ok: false,
    });
  });

  it('drops MIME-typed data through enter, over, and drop phases', async () => {
    const { commands, session } = createFakeSession({ targets: { e70: ref(70) } });

    const result = await runInteractBrowserTool(
      'browser_drop',
      { data: { 'text/plain': 'hello' }, target: 'e70' },
      session
    );

    expect(result.ok).toBe(true);
    const drags = commands.filter(command => command.method === 'Input.dispatchDragEvent');
    expect(drags.map(command => command.params?.['type'])).toEqual([
      'dragEnter',
      'dragOver',
      'drop',
    ]);
    expect(drags[0]?.params?.['data']).toMatchObject({
      items: [{ data: 'hello', mimeType: 'text/plain' }],
    });
  });

  it('refuses a path list whose entries name no file', async () => {
    const { commands, session } = createFakeSession({ targets: { e70: ref(70) } });

    const result = await runInteractBrowserTool(
      'browser_drop',
      { paths: [''], target: 'e70' },
      session
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('browser_drop: invalid arguments.');
      expect(result.error).toContain('paths');
      expect(result.error).not.toContain('At least one of');
    }
    expect(commands.filter(command => command.method === 'Input.dispatchDragEvent')).toEqual([]);
  });

  it('still drops data alongside an empty paths list', async () => {
    const { commands, session } = createFakeSession({ targets: { e70: ref(70) } });

    const result = await runInteractBrowserTool(
      'browser_drop',
      { data: { 'text/plain': 'hello' }, paths: [], target: 'e70' },
      session
    );

    expect(result.ok).toBe(true);
    const drags = commands.filter(command => command.method === 'Input.dispatchDragEvent');
    expect(drags.map(command => command.params?.['type'])).toEqual([
      'dragEnter',
      'dragOver',
      'drop',
    ]);
  });

  it('keeps the upstream wording for an empty paths list with no data', async () => {
    const { commands, session } = createFakeSession({ targets: { e70: ref(70) } });

    const result = await runInteractBrowserTool(
      'browser_drop',
      { paths: [], target: 'e70' },
      session
    );

    expect(result).toEqual({
      error: 'At least one of "paths" or "data" must be provided.',
      ok: false,
    });
    expect(commands.filter(command => command.method === 'Input.dispatchDragEvent')).toEqual([]);
  });
});

interface DomTypingFixture {
  readonly commands: RecordedCommand[];
  readonly events: string[];
  readonly field: (id: string) => HTMLElement;
  readonly session: BrowserToolInteractSession;
}

const isEditableHost = (element: Element | null): element is HTMLElement =>
  element instanceof HTMLElement &&
  element.closest('[contenteditable]:not([contenteditable="false"])') !== null;

/**
 * Email and number inputs expose no selection offsets, so jsdom cannot report
 * what `select()` covered; Chrome selects the whole value. The fake records it.
 */
const wholeValueSelected = new WeakSet<HTMLInputElement>();

const recordWholeValueSelection = (input: HTMLInputElement): void => {
  const select = input.select.bind(input);

  input.select = () => {
    select();
    wholeValueSelected.add(input);
  };
  input.addEventListener('blur', () => wholeValueSelected.delete(input));
};

/** What a browser does with text that reaches the focused element: it replaces the selection. */
const insertAtSelection = (text: string): void => {
  const active = document.activeElement;

  if (active instanceof HTMLInputElement && active.selectionStart === null) {
    active.value = wholeValueSelected.has(active) ? text : `${active.value}${text}`;
    wholeValueSelected.delete(active);
    active.dispatchEvent(new Event('input', { bubbles: true }));

    return;
  }

  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    active.setRangeText(text, active.selectionStart ?? 0, active.selectionEnd ?? 0, 'end');
    active.dispatchEvent(new Event('input', { bubbles: true }));

    return;
  }

  if (!isEditableHost(active)) {
    return;
  }

  const selection = globalThis.getSelection();

  if (selection === null) {
    return;
  }

  if (selection.rangeCount === 0 || !active.contains(selection.getRangeAt(0).startContainer)) {
    const caret = document.createRange();
    caret.setStart(active, 0);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  active.dispatchEvent(new Event('input', { bubbles: true }));
};

/**
 * A tab whose CDP commands run against a real jsdom document: functions the
 * tool calls on a node run with that element as `this`, and inserted text or
 * typed keys land where the browser would put them.
 */
const createDomTypingSession = (html: string): DomTypingFixture => {
  // The `isContentEditable` getter is missing from jsdom, which does implement contenteditable focus and selection.
  Object.defineProperty(HTMLElement.prototype, 'isContentEditable', {
    configurable: true,
    get(this: HTMLElement) {
      return isEditableHost(this);
    },
  });
  document.body.innerHTML = html;
  const commands: RecordedCommand[] = [];
  const events: string[] = [];
  const elements = [...document.body.querySelectorAll<HTMLElement>('[id]')];

  for (const input of document.body.querySelectorAll('input')) {
    recordWholeValueSelection(input);
  }
  const backendIdOf = (element: HTMLElement): number => 100 + elements.indexOf(element);
  const elementOf = (params: Record<string, unknown> | undefined): HTMLElement | undefined => {
    const objectId = params?.['objectId'];
    const backendNodeId =
      typeof objectId === 'string'
        ? Number(objectId.replace('node-', ''))
        : params?.['backendNodeId'];

    return typeof backendNodeId === 'number' ? elements[backendNodeId - 100] : undefined;
  };

  for (const element of elements) {
    for (const type of ['input', 'change', 'keydown']) {
      element.addEventListener(type, event => {
        const key = event instanceof KeyboardEvent ? `:${event.key}` : '';
        events.push(`${element.id}:${type}${key}`);
      });
    }
  }

  const session: BrowserToolInteractSession = {
    resolveTarget: async target => {
      const element = document.querySelector<HTMLElement>(`#${target}`);

      return element === null ? undefined : ref(backendIdOf(element));
    },
    send: async (method, params) => {
      commands.push({ method, params });

      switch (method) {
        case 'DOM.getBoxModel': {
          return { model: { content: REF_BOX } };
        }
        case 'DOM.focus': {
          elementOf(params)?.focus();

          return {};
        }
        case 'DOM.resolveNode': {
          const element = elementOf(params);

          return element === undefined
            ? undefined
            : { object: { objectId: `node-${String(backendIdOf(element))}` } };
        }
        case 'Runtime.callFunctionOn': {
          const element = elementOf(params);
          const declaration = String(params?.['functionDeclaration'] ?? '');
          const callArguments = z
            .array(z.object({ value: z.unknown() }))
            .parse(params?.['arguments'] ?? []);
          // eslint-disable-next-line eslint/no-new-func, typescript-eslint/no-implied-eval -- runs the page function the way Runtime.callFunctionOn does
          const declare = new Function(`return (${declaration});`) as () => (
            ...values: unknown[]
          ) => unknown;
          const run = declare();

          try {
            return {
              result: {
                value: run.apply(
                  element,
                  callArguments.map(entry => entry.value)
                ),
              },
            };
          } catch (error) {
            return { exceptionDetails: { exception: { description: String(error) } } };
          }
        }
        case 'Input.insertText': {
          insertAtSelection(String(params?.['text'] ?? ''));

          return {};
        }
        case 'Input.dispatchKeyEvent': {
          const key = String(params?.['key'] ?? '');

          if (params?.['type'] === 'keyDown') {
            document.activeElement?.dispatchEvent(
              new KeyboardEvent('keydown', { bubbles: true, key })
            );

            if (key === 'Delete') {
              insertAtSelection('');
            } else if (key !== 'Enter' && typeof params['text'] === 'string') {
              insertAtSelection(params['text']);
            }
          }

          return {};
        }
        default: {
          return {};
        }
      }
    },
  };

  return {
    commands,
    events,
    field: id => {
      const element = document.querySelector<HTMLElement>(`#${id}`);

      if (element === null) {
        throw new Error(`no fixture element #${id}`);
      }

      return element;
    },
    session,
  };
};

const valueOf = (element: HTMLElement): string =>
  element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
    ? element.value
    : (element.textContent ?? '');

const typeInto = (
  fixture: DomTypingFixture,
  args: { slowly?: boolean; submit?: boolean; target: string; text: string }
) => runInteractBrowserTool('browser_type', args, fixture.session);

describe('browser_type', () => {
  it.each([
    ['an input', '<input id="field" value="draft">', ['c2', 'c6', 'c10']],
    [
      'an email input',
      '<input id="field" type="email" value="draft@example.com">',
      ['c2@example.com', 'c6@example.com', 'c10@example.com'],
    ],
    ['a number input', '<input id="field" type="number" value="42">', ['2', '6', '10']],
    ['a textarea', '<textarea id="field">draft</textarea>', ['c2', 'c6', 'c10']],
    [
      'a contenteditable element',
      '<div id="field" contenteditable="true">draft</div>',
      ['c2', 'c6', 'c10'],
    ],
  ])('replaces what %s holds on every call, like Playwright fill', async (_label, html, texts) => {
    const fixture = createDomTypingSession(html);

    for (const text of texts) {
      // eslint-disable-next-line no-await-in-loop -- each call types into the field the previous call left
      const result = await typeInto(fixture, { target: 'field', text });

      expect(result.ok).toBe(true);
      expect(valueOf(fixture.field('field'))).toBe(text);
    }

    expect(fixture.events.filter(event => event === 'field:input')).toHaveLength(3);
  });

  it('clears the field when the text is empty', async () => {
    const fixture = createDomTypingSession('<input id="field" value="draft">');

    const result = await typeInto(fixture, { target: 'field', text: '' });

    expect(result.ok).toBe(true);
    expect(valueOf(fixture.field('field'))).toBe('');
  });

  it('sets a date input the way fill does, firing input and change', async () => {
    const fixture = createDomTypingSession('<input id="when" type="date" value="2026-01-01">');

    const result = await typeInto(fixture, { target: 'when', text: '2026-11-19' });

    expect(result.ok).toBe(true);
    expect(valueOf(fixture.field('when'))).toBe('2026-11-19');
    expect(fixture.events).toStrictEqual(['when:input', 'when:change']);
  });

  it('fills the control a label names when the target is the label', async () => {
    const fixture = createDomTypingSession(
      '<label id="label">Email <input id="email" value="old@example.com"></label>'
    );

    await typeInto(fixture, { target: 'label', text: 'new@example.com' });

    expect(valueOf(fixture.field('email'))).toBe('new@example.com');
  });

  it('fails instead of reporting typed text for an element that cannot take it, with or without slowly', async () => {
    const fixture = createDomTypingSession(
      '<p id="status">idle</p><input id="locked" value="kept" readonly><textarea id="off" disabled>kept</textarea>'
    );

    const outcomes = [];

    for (const slowly of [false, true]) {
      for (const target of ['status', 'locked', 'off']) {
        // eslint-disable-next-line no-await-in-loop -- one call per target, each against an untouched page
        outcomes.push(await typeInto(fixture, { slowly, target, text: 'x' }));
      }
    }

    const notEditable = {
      error: 'Element is not an <input>, <textarea> or [contenteditable] element',
      ok: false,
    };
    const readOnly = {
      error: 'The element is not editable: it is disabled or read-only.',
      ok: false,
    };

    expect(outcomes).toStrictEqual([
      notEditable,
      readOnly,
      readOnly,
      notEditable,
      readOnly,
      readOnly,
    ]);
    expect(valueOf(fixture.field('status'))).toBe('idle');
    expect(valueOf(fixture.field('locked'))).toBe('kept');
    expect(valueOf(fixture.field('off'))).toBe('kept');
    expect(keyEvents(fixture.commands)).toHaveLength(0);
  });

  it('refuses a number input text that is not a number, leaving its value', async () => {
    const fixture = createDomTypingSession('<input id="count" type="number" value="42">');

    const result = await typeInto(fixture, { target: 'count', text: 'many' });

    expect(result).toStrictEqual({
      error: 'Cannot type text into input[type=number]',
      ok: false,
    });
    expect(valueOf(fixture.field('count'))).toBe('42');
  });

  it('presses Enter on the field after replacing its text when submit is set', async () => {
    const fixture = createDomTypingSession('<input id="query" value="old">');

    const result = await typeInto(fixture, { submit: true, target: 'query', text: 'new' });

    expect(result.ok).toBe(true);
    expect(valueOf(fixture.field('query'))).toBe('new');
    expect(fixture.events.at(-1)).toBe('query:keydown:Enter');
  });

  it('types slowly at the caret a fresh focus gives, then keeps appending while focused', async () => {
    const fixture = createDomTypingSession('<input id="other"><input id="field" value="abc">');
    fixture.field('other').focus();

    await typeInto(fixture, { slowly: true, target: 'field', text: 'x' });

    // Playwright's pressSequentially puts the caret at the start of an input it focuses.
    expect(valueOf(fixture.field('field'))).toBe('xabc');

    await typeInto(fixture, { slowly: true, target: 'field', text: 'yz' });

    expect(valueOf(fixture.field('field'))).toBe('xyzabc');
    expect(fixture.events.filter(event => event.startsWith('field:keydown:'))).toStrictEqual([
      'field:keydown:x',
      'field:keydown:y',
      'field:keydown:z',
    ]);
  });

  it('types punctuation in slowly mode instead of dropping it', async () => {
    const fixture = createDomTypingSession('<input id="field">');

    await typeInto(fixture, { slowly: true, target: 'field', text: 'a.b' });

    expect(valueOf(fixture.field('field'))).toBe('a.b');
    expect(fixture.commands.some(command => command.method === 'Input.insertText')).toBe(false);
    expect(keyEvents(fixture.commands)[2]).toMatchObject({
      code: 'Period',
      text: '.',
      type: 'keyDown',
      windowsVirtualKeyCode: 190,
    });
  });

  it('inserts a character the US layout cannot type when slowly is set', async () => {
    const fixture = createDomTypingSession('<input id="field">');

    await typeInto(fixture, { slowly: true, target: 'field', text: 'é' });

    expect(keyEvents(fixture.commands)).toHaveLength(0);
    expect(valueOf(fixture.field('field'))).toBe('é');
  });
});

describe('browser_press_key', () => {
  it('dispatches keydown and keyup for a named key', async () => {
    const { commands, session } = createFakeSession();

    const result = await runInteractBrowserTool('browser_press_key', { key: 'ArrowLeft' }, session);

    expect(result).toEqual({ ok: true, value: 'Pressed "ArrowLeft".' });
    expect(keyEvents(commands)).toHaveLength(2);
    expect(keyEvents(commands)[0]).toMatchObject({
      code: 'ArrowLeft',
      key: 'ArrowLeft',
      type: 'keyDown',
      windowsVirtualKeyCode: 37,
    });
  });

  it('maps a shifted symbol to its US-layout physical key and VK', async () => {
    const { commands, session } = createFakeSession();

    const result = await runInteractBrowserTool('browser_press_key', { key: '#' }, session);

    expect(result).toEqual({ ok: true, value: 'Pressed "#".' });
    const events = keyEvents(commands);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      code: 'Digit3',
      key: '#',
      modifiers: 8,
      text: '#',
      type: 'keyDown',
      windowsVirtualKeyCode: 51,
    });
    expect(events[1]).toMatchObject({
      code: 'Digit3',
      key: '#',
      modifiers: 8,
      type: 'keyUp',
      windowsVirtualKeyCode: 51,
    });
  });

  it('maps punctuation to its physical key instead of the colliding ASCII code', async () => {
    const { commands, session } = createFakeSession();

    await runInteractBrowserTool('browser_press_key', { key: '.' }, session);

    const [down] = keyEvents(commands);
    expect(down).toMatchObject({ code: 'Period', key: '.', type: 'keyDown' });
    expect(down?.['windowsVirtualKeyCode']).toBe(190);
    expect(down?.['windowsVirtualKeyCode']).not.toBe(46);
  });

  it('holds the modifier through a chord', async () => {
    const { commands, session } = createFakeSession();

    await runInteractBrowserTool('browser_press_key', { key: 'Control+A' }, session);

    const events = keyEvents(commands);
    expect(events.map(event => event['key'])).toEqual(['Control', 'A', 'A', 'Control']);
    expect(events[1]?.['modifiers']).toBe(2);
    expect(events[3]?.['modifiers']).toBe(0);
  });

  it('rejects an unknown key name instead of silently doing nothing', async () => {
    const { commands, session } = createFakeSession();

    const result = await runInteractBrowserTool(
      'browser_press_key',
      { key: 'Frobnicate' },
      session
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Unknown key "Frobnicate"');
    }
    expect(commands).toHaveLength(0);
  });
});

describe('browser_select_option', () => {
  it('selects a value through the page-helper layer', async () => {
    const { commands, session } = createFakeSession({
      pageHelper: { ok: true, result: ['Tea'] },
      targets: { '#drink': selector(5, '#drink') },
    });

    const result = await runInteractBrowserTool(
      'browser_select_option',
      { target: '#drink', values: ['Tea'] },
      session
    );

    expect(result).toEqual({ ok: true, value: 'Selected "Tea" in "#drink".' });
    const evaluations = commands.filter(command => command.method === 'Runtime.evaluate');
    expect(String(evaluations[0]?.params?.['expression'])).toContain('page.waitFor');
    expect(String(evaluations[0]?.params?.['expression'])).toContain('#drink');
  });

  it('surfaces the real options when nothing matches', async () => {
    const { session } = createFakeSession({
      pageHelper: {
        error: 'No option matches "Cola". Available options: Tea, Coffee',
        ok: false,
      },
      targets: { '#drink': selector(5, '#drink') },
    });

    const result = await runInteractBrowserTool(
      'browser_select_option',
      { target: '#drink', values: ['Cola'] },
      session
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Available options: Tea, Coffee');
    }
  });

  it('selects through a snapshot ref in a session that never requested the document', async () => {
    const { commands, session } = createFakeSession({
      pageHelper: { ok: true, result: ['Tea'] },
      targets: { e70: ref(70) },
    });

    const result = await runInteractBrowserTool(
      'browser_select_option',
      { element: 'Drink', target: 'e70', values: ['Tea'] },
      session
    );

    expect(result).toEqual({ ok: true, value: 'Selected "Tea" in "Drink".' });
    expect(commands).toContainEqual({
      method: 'DOM.resolveNode',
      params: { backendNodeId: 70 },
    });
    const evaluations = commands.filter(command => command.method === 'Runtime.evaluate');
    expect(String(evaluations[0]?.params?.['expression'])).toContain('data-kilo-tool-target');
  });

  it('reports a stale ref when the ref node is detached from the document', async () => {
    const { commands, session } = createFakeSession({
      node: document.createElement('select'),
      targets: { e70: ref(70) },
    });

    const result = await runInteractBrowserTool(
      'browser_select_option',
      { target: 'e70', values: ['Tea'] },
      session
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('stale or unknown');
      expectFreshSnapshotHint(result.error);
    }
    expect(commands.some(command => command.method === 'Runtime.evaluate')).toBe(false);
  });

  it('reports a stale ref when the node cannot be resolved to a remote object', async () => {
    const { session } = createFakeSession({
      resolveNodeError: 'Could not find node with given id',
      targets: { e70: ref(70) },
    });

    const result = await runInteractBrowserTool(
      'browser_select_option',
      { target: 'e70', values: ['Tea'] },
      session
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('stale or unknown');
      expectFreshSnapshotHint(result.error);
    }
  });
});

describe('browser_fill_form', () => {
  it('reports a per-field outcome for each descriptor', async () => {
    const { commands, session } = createFakeSession({
      pageHelper: expression =>
        expression.includes('.checked') ? { ok: true, result: false } : { ok: true, result: true },
      targets: { e1: ref(1), e2: ref(2) },
    });

    const result = await runInteractBrowserTool(
      'browser_fill_form',
      {
        fields: [
          { name: 'Email', target: 'e1', type: 'textbox', value: 'a@b.c' },
          { name: 'Agree', target: 'e2', type: 'checkbox', value: 'true' },
        ],
      },
      session
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('Email: ok');
      expect(result.value).toContain('Agree: ok');
    }
    expect(commands.some(command => command.method === 'Input.dispatchMouseEvent')).toBe(true);
  });

  it('fills a snapshot ref, then untags the node and releases its remote object', async () => {
    const { commands, session } = createFakeSession({
      pageHelper: { ok: true, result: true },
      targets: { e1: ref(1) },
    });

    const result = await runInteractBrowserTool(
      'browser_fill_form',
      { fields: [{ name: 'Email', target: 'e1', type: 'textbox', value: 'a@b.c' }] },
      session
    );

    expect(result).toEqual({
      ok: true,
      value: 'Filled 1 field(s).\nEmail: ok — filled with "a@b.c"',
    });
    const fill = commands.findIndex(command => command.method === 'Runtime.evaluate');
    const untag = commands.findIndex(
      command =>
        command.method === 'Runtime.callFunctionOn' &&
        String(command.params?.['functionDeclaration']).includes('removeAttribute')
    );
    const release = commands.findIndex(command => command.method === 'Runtime.releaseObject');
    expect(fill).toBeGreaterThanOrEqual(0);
    expect(untag).toBeGreaterThan(fill);
    expect(release).toBeGreaterThan(untag);
    expect(commands[release]?.params).toEqual({ objectId: 'kilo-node-object' });
  });

  it('reports every field while failing when one field cannot resolve', async () => {
    const { session } = createFakeSession({
      pageHelper: { ok: true, result: true },
      targets: { e1: ref(1) },
    });

    const result = await runInteractBrowserTool(
      'browser_fill_form',
      {
        fields: [
          { name: 'Email', target: 'e1', type: 'textbox', value: 'a@b.c' },
          { name: 'Missing', target: 'e404', type: 'textbox', value: 'x' },
        ],
      },
      session
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Email: ok');
      expect(result.error).toContain('Missing: failed');
    }
  });

  it('reports a detached ref as a field failure before running the page helper', async () => {
    const { commands, session } = createFakeSession({
      node: document.createElement('input'),
      targets: { e1: ref(1) },
    });

    const result = await runInteractBrowserTool(
      'browser_fill_form',
      { fields: [{ name: 'Email', target: 'e1', type: 'textbox', value: 'a@b.c' }] },
      session
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Email: failed');
      expect(result.error).toContain('stale or unknown');
    }
    expect(commands.some(command => command.method === 'Runtime.evaluate')).toBe(false);
    expect(commands).toContainEqual({
      method: 'Runtime.releaseObject',
      params: { objectId: 'kilo-node-object' },
    });
  });

  it('reports a page that refuses the tag instead of calling the live ref stale', async () => {
    const node = attachedField();
    // A page can replace the setter its own tree uses; the ref is live, so a snapshot would change nothing.
    const original = node.setAttribute.bind(node);

    node.setAttribute = () => {
      throw new Error('setAttribute is disabled');
    };
    const { session } = createFakeSession({ node, targets: { e70: ref(70) } });

    const result = await runInteractBrowserTool(
      'browser_select_option',
      { target: 'e70', values: ['Tea'] },
      session
    );

    node.setAttribute = original;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('would not let this tool mark the element');
      expect(result.error).toContain('CSS selector');
      // The ref is live: the stale hint would send the model after a snapshot that cannot help.
      expect(result.error).not.toContain('stale or unknown');
    }
  });

  it('reports a page whose setAttribute silently does nothing instead of calling the live ref stale', async () => {
    const node = attachedField();

    // No throw, no attribute: the read-back is what tells this apart from a tag that landed.
    node.setAttribute = () => {};
    const { session } = createFakeSession({ node, targets: { e70: ref(70) } });

    const result = await runInteractBrowserTool(
      'browser_select_option',
      { target: 'e70', values: ['Tea'] },
      session
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('would not let this tool mark the element');
      expect(result.error).not.toContain('stale or unknown');
    }
  });

  it('reports a ref inside a shadow root at once instead of waiting for a selector it cannot reach', async () => {
    const host = document.createElement('div');
    const part = document.createElement('input');
    document.body.append(host);
    host.attachShadow({ mode: 'closed' }).append(part);
    const { commands, session } = createFakeSession({ node: part, targets: { e1: ref(1) } });

    const result = await runInteractBrowserTool(
      'browser_fill_form',
      { fields: [{ name: 'Month', target: 'e1', type: 'textbox', value: '05' }] },
      session
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Month: failed');
      expect(result.error).toContain('Target the control itself with a CSS selector');
    }
    expect(part.dataset['kiloToolTarget']).toBeUndefined();
    expect(commands.some(command => command.method === 'Runtime.evaluate')).toBe(false);
  });
});
