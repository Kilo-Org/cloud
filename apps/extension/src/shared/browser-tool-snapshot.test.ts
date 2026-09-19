// @vitest-environment jsdom
/* eslint-disable max-lines, require-await, typescript-eslint/no-base-to-string, typescript-eslint/no-unsafe-type-assertion, typescript-eslint/require-await, unicorn/no-useless-undefined, vitest/prefer-describe-function-title -- Fake CDP session records verbatim commands; Runtime.evaluate is executed in jsdom for the DOM fallback. */
import { describe, expect, it } from 'vitest';
import { TAB_NOT_INSPECTABLE_ERROR } from './tab-debugger';
import {
  buildBrowserAriaSnapshot,
  captureBrowserAriaSnapshot,
  describeUnsupportedFilename,
  renderBrowserAriaSnapshot,
} from './browser-tool-snapshot';
import type { BrowserAriaNode, BrowserToolPageSession } from './browser-tool-snapshot';
import type { BrowserToolRefEntry } from './browser-tool-session';

interface RecordedCommand {
  readonly method: string;
  readonly params: Record<string, unknown> | undefined;
}

const evaluateExpression = async (expression: string): Promise<unknown> => {
  // eslint-disable-next-line eslint/no-new-func, typescript-eslint/no-implied-eval -- mirrors the tab injection path
  const run = new Function(`return (${expression});`) as () => unknown;

  return run();
};

const createFakeSession = ({
  axNodes = [],
  axUnsupported = false,
  boxes = {},
  refs = {},
}: {
  axNodes?: readonly BrowserAriaNode[];
  axUnsupported?: boolean;
  boxes?: Record<number, { content: number[]; height: number; width: number }>;
  refs?: Record<string, number>;
} = {}): {
  commands: RecordedCommand[];
  registeredRefs: BrowserToolRefEntry[][];
  registerOptions: ({ readonly merge?: boolean } | undefined)[];
  session: BrowserToolPageSession;
} => {
  const commands: RecordedCommand[] = [];
  const registeredRefs: BrowserToolRefEntry[][] = [];
  const registerOptions: ({ readonly merge?: boolean } | undefined)[] = [];

  const session: BrowserToolPageSession = {
    attach: async () => undefined,
    consoleMessages: () => [],
    networkRequestsSinceLoad: () => [],
    registerRefs: (entries, options) => {
      registeredRefs.push([...entries]);
      registerOptions.push(options);
    },
    resolveTarget: async (target: string) => {
      const backendNodeId = refs[target];

      return backendNodeId === undefined ? undefined : { backendNodeId, kind: 'ref', ref: target };
    },
    send: async (method, params) => {
      commands.push({ method, params });

      if (method === 'Accessibility.getFullAXTree') {
        if (axUnsupported) {
          throw new Error('Accessibility domain is not supported.');
        }

        return { nodes: axNodes };
      }

      if (method === 'DOM.getBoxModel') {
        const backendNodeId = params?.['backendNodeId'];

        return typeof backendNodeId === 'number' && boxes[backendNodeId] !== undefined
          ? { model: boxes[backendNodeId] }
          : {};
      }

      if (method === 'DOM.describeNode') {
        return { node: { backendDOMNodeId: 11 } };
      }

      if (method === 'Runtime.evaluate') {
        const expression = String(params?.['expression'] ?? '');

        return { result: { value: await evaluateExpression(expression) } };
      }

      return {};
    },
  };

  return { commands, registerOptions, registeredRefs, session };
};

const axNode = (node: {
  backendDOMNodeId?: number;
  childIds?: string[];
  ignored?: boolean;
  name?: string;
  nodeId: string;
  properties?: { name: string; value: string | number | boolean }[];
  role?: string;
}): BrowserAriaNode => ({
  nodeId: node.nodeId,
  ...(node.backendDOMNodeId === undefined ? {} : { backendDOMNodeId: node.backendDOMNodeId }),
  ...(node.childIds === undefined ? {} : { childIds: node.childIds }),
  ...(node.ignored === undefined ? {} : { ignored: node.ignored }),
  ...(node.name === undefined ? {} : { name: { value: node.name } }),
  ...(node.properties === undefined
    ? {}
    : {
        properties: node.properties.map(property => ({
          name: property.name,
          value: { value: property.value },
        })),
      }),
  ...(node.role === undefined ? {} : { role: { value: node.role } }),
});

const SAMPLE_TREE: BrowserAriaNode[] = [
  axNode({ childIds: ['2', '3'], nodeId: '1', role: 'generic' }),
  axNode({ backendDOMNodeId: 11, childIds: ['4'], name: 'Welcome', nodeId: '2', role: 'heading' }),
  axNode({ backendDOMNodeId: 12, name: 'Submit', nodeId: '3', role: 'button' }),
  axNode({ ignored: true, name: 'Hello', nodeId: '4', role: 'StaticText' }),
];

describe('buildBrowserAriaSnapshot', () => {
  it('renders indented lines and refs only the interactive nodes', () => {
    const snapshot = buildBrowserAriaSnapshot(SAMPLE_TREE);

    expect(renderBrowserAriaSnapshot(snapshot)).toBe(
      ['  - heading "Welcome"', '  - button "Submit" [ref=e12]'].join('\n')
    );
    expect(snapshot.refs).toStrictEqual([{ backendNodeId: 12, ref: 'e12' }]);
  });

  it('renders text leaves and CDP state attributes', () => {
    const snapshot = buildBrowserAriaSnapshot([
      axNode({
        backendDOMNodeId: 5,
        childIds: ['2'],
        name: 'Question',
        nodeId: '1',
        properties: [{ name: 'level', value: 3 }],
        role: 'heading',
      }),
      axNode({ name: 'Answer', nodeId: '2', role: 'StaticText' }),
      axNode({
        backendDOMNodeId: 6,
        name: 'Accept',
        nodeId: '3',
        properties: [{ name: 'checked', value: true }],
        role: 'checkbox',
      }),
    ]);

    expect(renderBrowserAriaSnapshot(snapshot)).toBe(
      [
        '- heading "Question"[level=3]',
        '  - text: Answer',
        '- checkbox "Accept" [ref=e6][checked]',
      ].join('\n')
    );
  });

  it('honours depth by pruning deeper levels', () => {
    const snapshot = buildBrowserAriaSnapshot(
      [
        axNode({ childIds: ['2'], nodeId: '1', role: 'generic' }),
        axNode({
          backendDOMNodeId: 11,
          childIds: ['3'],
          name: 'Welcome',
          nodeId: '2',
          role: 'heading',
        }),
        axNode({ name: 'Deep', nodeId: '3', role: 'StaticText' }),
      ],
      { depth: 1 }
    );

    expect(renderBrowserAriaSnapshot(snapshot)).toBe('  - heading "Welcome"');
  });

  it('renders only the subtree for a target backend node id', () => {
    const snapshot = buildBrowserAriaSnapshot(SAMPLE_TREE, { rootBackendNodeId: 11 });

    expect(renderBrowserAriaSnapshot(snapshot)).toBe('- heading "Welcome"');
  });

  it('renders nothing for a target the tree does not contain', () => {
    // A hidden element resolves through the DOM but is absent from the accessibility tree; the whole page must not come back.
    const snapshot = buildBrowserAriaSnapshot(SAMPLE_TREE, { rootBackendNodeId: 99 });

    expect(snapshot.lines).toStrictEqual([]);
    expect(snapshot.refs).toStrictEqual([]);
  });
});

describe('captureBrowserAriaSnapshot', () => {
  it('registers the emitted refs and keeps a ref stable across snapshots', async () => {
    const { registerOptions, registeredRefs, session } = createFakeSession({
      axNodes: SAMPLE_TREE,
    });

    const first = await captureBrowserAriaSnapshot(session, {});
    const second = await captureBrowserAriaSnapshot(session, {});

    expect(first.text).toBe(second.text);
    expect(first.refs).toStrictEqual([{ backendNodeId: 12, ref: 'e12' }]);
    expect(registerOptions).toStrictEqual([{ merge: false }, { merge: false }]);
    expect(registeredRefs).toStrictEqual([
      [{ backendNodeId: 12, ref: 'e12' }],
      [{ backendNodeId: 12, ref: 'e12' }],
    ]);
  });

  it('adds viewport-relative boxes when boxes is true', async () => {
    const { session } = createFakeSession({
      axNodes: SAMPLE_TREE,
      boxes: { 12: { content: [5, 10, 105, 10, 105, 30, 5, 30], height: 20, width: 100 } },
    });

    const capture = await captureBrowserAriaSnapshot(session, { boxes: true });

    expect(capture.text).toContain('- button "Submit" [ref=e12] [box=5,10,100,20]');
  });

  it('renders a target subtree resolved from a snapshot ref', async () => {
    const { commands, registerOptions, session } = createFakeSession({
      axNodes: [
        axNode({ childIds: ['2', '3'], nodeId: '1', role: 'generic' }),
        axNode({
          backendDOMNodeId: 11,
          childIds: ['4'],
          name: 'Welcome',
          nodeId: '2',
          role: 'heading',
        }),
        axNode({ backendDOMNodeId: 12, name: 'Submit', nodeId: '3', role: 'button' }),
        axNode({ name: 'Hello', nodeId: '4', role: 'StaticText' }),
      ],
      refs: { e11: 11 },
    });

    const capture = await captureBrowserAriaSnapshot(session, { target: 'e11' });

    expect(capture.text).toBe('- heading "Welcome"\n  - text: Hello');
    expect(registerOptions).toStrictEqual([{ merge: true }]);
    expect(commands.some(command => command.method === 'Accessibility.getFullAXTree')).toBe(true);
  });

  it('errors instead of returning the whole page for a target missing from the accessibility tree', async () => {
    // The ref resolves through the DOM, but the accessibility tree omits the element (hidden); the snapshot must not widen to the page.
    const { session } = createFakeSession({ axNodes: SAMPLE_TREE, refs: { e99: 99 } });

    await expect(captureBrowserAriaSnapshot(session, { target: 'e99' })).rejects.toThrow(
      'The accessibility tree has no node for target'
    );
  });

  it('falls back to the injected DOM walker when accessibility is unavailable', async () => {
    document.body.innerHTML = '<main><h1>Hello</h1><button aria-label="Go">Go</button></main>';

    const { session } = createFakeSession({ axUnsupported: true });

    const capture = await captureBrowserAriaSnapshot(session, {});

    expect(capture.text).toContain('- heading "Hello"[level=1]');
    expect(capture.text).toContain('- button "Go" [ref=e1]');
    expect(capture.refs).toStrictEqual([{ ref: 'e1', selector: 'html > body > main > button' }]);
  });

  it('returns a placeholder instead of an empty result for an empty page', async () => {
    document.body.innerHTML = '';
    const { session } = createFakeSession({ axUnsupported: true });

    const capture = await captureBrowserAriaSnapshot(session, {});

    expect(capture.text).toBe('(no accessibility nodes)');
  });

  it('surfaces an uninspectable tab instead of an empty result', async () => {
    const session: BrowserToolPageSession = {
      attach: async () => undefined,
      consoleMessages: () => [],
      networkRequestsSinceLoad: () => [],
      registerRefs: () => undefined,
      resolveTarget: async () => undefined,
      send: async () => {
        throw new Error(TAB_NOT_INSPECTABLE_ERROR);
      },
    };

    await expect(captureBrowserAriaSnapshot(session, {})).rejects.toThrow(
      TAB_NOT_INSPECTABLE_ERROR
    );
  });
});

describe('filename support', () => {
  it('explains that a filename cannot be written', () => {
    expect(describeUnsupportedFilename('snapshot.yaml')).toContain('could not be written');
    expect(describeUnsupportedFilename('snapshot.yaml')).toContain('snapshot.yaml');
  });
});
