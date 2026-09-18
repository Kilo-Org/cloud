/* eslint-disable id-length, jest/no-conditional-expect, jest/no-conditional-in-test, jest/prefer-strict-equal, max-lines, require-await, typescript-eslint/no-base-to-string, typescript-eslint/no-unsafe-type-assertion, typescript-eslint/require-await, unicorn/prefer-array-find, vitest/prefer-describe-function-title -- Fake CDP session records verbatim commands; assertions check conditional error branches. */
import { describe, expect, it } from 'vitest';
import {
  INTERACT_BROWSER_TOOL_NAMES,
  isInteractBrowserToolName,
  runInteractBrowserTool,
} from './browser-tool-interact-actions';
import type { BrowserToolInteractSession } from './browser-tool-interact-actions';
import type { BrowserToolResolvedTarget } from './browser-tool-session';

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
  nodeConnected = true,
  pageHelper,
  pushError,
  resolveNodeError,
  targets = {},
}: {
  /** A CDP rejection, as when the ref's node was removed without a navigation. */
  boxModelError?: string;
  boxes?: Record<number, number[]>;
  /** Whether `DOM.resolveNode` + `Runtime.callFunctionOn` report the node attached. */
  nodeConnected?: boolean;
  pageHelper?: FakePageHelperEnvelope | ((expression: string) => FakePageHelperEnvelope);
  /** A CDP rejection while resolving the ref to a frontend node id. */
  pushError?: string;
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
        if (pushError !== undefined) {
          throw new Error(pushError);
        }

        return { nodeIds: [77] };
      }

      if (method === 'DOM.resolveNode') {
        if (resolveNodeError !== undefined) {
          throw new Error(resolveNodeError);
        }

        return { object: { objectId: 'kilo-node-object' } };
      }

      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: nodeConnected } };
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
      expect(result.error).toContain('kilo_browser_snapshot');
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
      expect(result.error).toContain('kilo_browser_snapshot');
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
});

describe('browser_type', () => {
  it('focuses the element and inserts the whole string by default', async () => {
    const { commands, session } = createFakeSession({ targets: { e70: ref(70) } });

    const result = await runInteractBrowserTool(
      'browser_type',
      { target: 'e70', text: 'hello' },
      session
    );

    expect(result.ok).toBe(true);
    expect(commands.some(command => command.method === 'DOM.focus')).toBe(true);
    const inserts = commands.filter(command => command.method === 'Input.insertText');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.params).toEqual({ text: 'hello' });
  });

  it('types one key event pair per character when slowly is set', async () => {
    const { commands, session } = createFakeSession({ targets: { e70: ref(70) } });

    await runInteractBrowserTool(
      'browser_type',
      { slowly: true, target: 'e70', text: 'ab' },
      session
    );

    expect(commands.some(command => command.method === 'Input.insertText')).toBe(false);
    const events = keyEvents(commands);
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ key: 'a', text: 'a', type: 'keyDown' });
    expect(events[1]).toMatchObject({ key: 'a', type: 'keyUp' });
  });

  it('types punctuation in slowly mode instead of dropping it', async () => {
    const { commands, session } = createFakeSession({ targets: { e70: ref(70) } });

    await runInteractBrowserTool(
      'browser_type',
      { slowly: true, target: 'e70', text: 'a.b' },
      session
    );

    expect(commands.some(command => command.method === 'Input.insertText')).toBe(false);
    const events = keyEvents(commands);
    expect(events.map(event => event['key'])).toEqual(['a', 'a', '.', '.', 'b', 'b']);
    expect(events[2]).toMatchObject({
      code: 'Period',
      text: '.',
      type: 'keyDown',
      windowsVirtualKeyCode: 190,
    });
  });

  it('inserts a character the US layout cannot type when slowly is set', async () => {
    const { commands, session } = createFakeSession({ targets: { e70: ref(70) } });

    await runInteractBrowserTool(
      'browser_type',
      { slowly: true, target: 'e70', text: 'é' },
      session
    );

    expect(keyEvents(commands)).toHaveLength(0);
    const inserts = commands.filter(command => command.method === 'Input.insertText');
    expect(inserts.map(command => command.params)).toEqual([{ text: 'é' }]);
  });

  it('presses Enter after typing when submit is set', async () => {
    const { commands, session } = createFakeSession({ targets: { e70: ref(70) } });

    await runInteractBrowserTool(
      'browser_type',
      { submit: true, target: 'e70', text: 'x' },
      session
    );

    const events = keyEvents(commands);
    expect(events.at(-2)).toMatchObject({ key: 'Enter', type: 'keyDown' });
    expect(events.at(-1)).toMatchObject({ key: 'Enter', type: 'keyUp' });
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

  it('reports a stale ref when the ref node is gone before the DOM-side lookup', async () => {
    const { session } = createFakeSession({
      pushError: 'Could not find node with given id',
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
      expect(result.error).toContain('kilo_browser_snapshot');
    }
  });

  it('reports a stale ref when the ref node is detached from the document', async () => {
    const { commands, session } = createFakeSession({
      nodeConnected: false,
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
      expect(result.error).toContain('kilo_browser_snapshot');
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
      expect(result.error).toContain('kilo_browser_snapshot');
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

  it('releases the remote object it resolved to check the node', async () => {
    const { commands, session } = createFakeSession({
      pageHelper: { ok: true, result: true },
      targets: { e1: ref(1) },
    });

    await runInteractBrowserTool(
      'browser_fill_form',
      { fields: [{ name: 'Email', target: 'e1', type: 'textbox', value: 'a@b.c' }] },
      session
    );

    expect(commands).toContainEqual({
      method: 'Runtime.releaseObject',
      params: { objectId: 'kilo-node-object' },
    });
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
      nodeConnected: false,
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
  });
});
