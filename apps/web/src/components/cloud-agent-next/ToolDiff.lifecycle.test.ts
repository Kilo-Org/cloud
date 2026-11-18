import { createRequire } from 'node:module';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiffEditorProps, DiffOnMount } from '@monaco-editor/react';
import { ToolDiff } from './ToolDiff';

type DiffEditorInstance = Parameters<DiffOnMount>[0];
type DiffModel = NonNullable<ReturnType<DiffEditorInstance['getModel']>>;
type Resources = { editorDisposals: number; modelDisposals: number[] };

const resources: Resources[] = [];
const disposalErrors: string[] = [];

function createDiffEditor(): DiffEditorInstance {
  const owned = { editorDisposals: 0, modelDisposals: [0, 0] };
  resources.push(owned);
  let attached: DiffModel | null = null;
  const createModel = (index: number) => ({
    dispose() {
      if (attached) disposalErrors.push('Model disposed before editor detachment');
      owned.modelDisposals[index]++;
    },
    isDisposed: () => owned.modelDisposals[index] > 0,
  });
  attached = {
    original: createModel(0) as DiffModel['original'],
    modified: createModel(1) as DiffModel['modified'],
  };
  const editor: Pick<DiffEditorInstance, 'getModel' | 'setModel' | 'dispose'> = {
    getModel: () => attached,
    setModel(model) {
      if (model !== null) throw new Error('The lifecycle fixture only supports detachment');
      attached = null;
    },
    dispose() {
      owned.editorDisposals++;
      attached = null;
    },
  };
  return editor as DiffEditorInstance;
}

jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () =>
    function MockDiffEditor({
      onMount,
      keepCurrentOriginalModel = false,
      keepCurrentModifiedModel = false,
    }: DiffEditorProps) {
      const mount = React.useRef(onMount);
      React.useEffect(() => {
        const editor = createDiffEditor();
        mount.current?.(editor, {} as Parameters<DiffOnMount>[1]);
        return () => {
          const models = editor.getModel();
          if (!keepCurrentOriginalModel) models?.original.dispose();
          if (!keepCurrentModifiedModel) models?.modified.dispose();
          editor.dispose();
        };
      }, []);
      return React.createElement('div', { 'data-monaco-diff': true });
    },
}));

function installDom() {
  const requireFromHere = createRequire(__filename);
  const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));
  const { window, document } = (
    requireFromNext('linkedom') as {
      parseHTML: (html: string) => { window: Record<string, unknown>; document: Document };
    }
  ).parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const values = {
    React,
    window,
    document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(values).map(name => [name, globals[name]]));
  Object.assign(globals, values);
  const container = document.getElementById('root');
  if (!container) throw new Error('Lifecycle test root missing');
  return {
    container,
    cleanup: () => previous.forEach((value, name) => (globals[name] = value)),
  };
}

function liveModels() {
  return resources.reduce(
    (total, owned) => total + owned.modelDisposals.filter(disposals => disposals === 0).length,
    0
  );
}

function expectDisposed() {
  expect(disposalErrors).toEqual([]);
  expect(liveModels()).toBe(0);
  for (const owned of resources) {
    expect(owned.editorDisposals).toBe(1);
    expect(owned.modelDisposals).toEqual([1, 1]);
  }
}

describe('ToolDiff mounted Monaco lifetime', () => {
  let root: Root | undefined;
  let container: HTMLElement;
  let cleanup: () => void;

  beforeEach(() => {
    resources.length = 0;
    disposalErrors.length = 0;
    const dom = installDom();
    container = dom.container;
    cleanup = dom.cleanup;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    cleanup();
  });

  function render(props: React.ComponentProps<typeof ToolDiff> | null, strict: boolean) {
    act(() => {
      root?.render(
        React.createElement(
          strict ? React.StrictMode : React.Fragment,
          null,
          props ? React.createElement(ToolDiff, props) : null
        )
      );
    });
  }

  it.each([false, true])(
    'detaches and releases resources on close/reopen (StrictMode=%p)',
    strict => {
      for (let round = 0; round < 2; round++) {
        render({ original: 'Before', modified: 'After' }, strict);
        expect(liveModels()).toBe(2);
        expect(container.querySelectorAll('[data-monaco-diff]')).toHaveLength(1);
        render(null, strict);
        expectDisposed();
      }
      if (strict) expect(resources).toHaveLength(4);
    }
  );

  it.each([false, true])(
    'releases the Monaco branch when metadata replaces snippets without unmounting ToolDiff (StrictMode=%p)',
    strict => {
      const snippets = { original: 'Before', modified: 'After' };
      render(snippets, strict);
      expect(liveModels()).toBe(2);

      render(
        { ...snippets, patch: '--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-Before\n+After\n' },
        strict
      );
      expect(container.querySelector('[aria-label="Unified patch"]')).not.toBeNull();
      expect(container.querySelector('[data-monaco-diff]')).toBeNull();
      expectDisposed();

      render(snippets, strict);
      expect(liveModels()).toBe(2);
      render(null, strict);
      expectDisposed();
    }
  );
});
