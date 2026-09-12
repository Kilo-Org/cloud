import { createElement, type ElementType, type ReactElement } from 'react';
import { createRoot, type Fiber, type JsonElement, type Root } from 'test-renderer';

import { act } from './renderer-act';
export { act } from './renderer-act';

// Rendering and scheduling belong to the maintained renderer used by RNTL 14.
// The existing contract tests also inspect provider/component props and identity.
// Keep those assertions via its documented Fiber escape hatch, not a second
// reconciler or the deprecated react-test-renderer package.
type FindOptions = { deep?: boolean };
type Predicate = (node: Instance) => boolean;

type Instance = {
  type: ElementType;
  props: JsonElement['props'];
  parent: Instance | null;
  children: (Instance | string)[];
  find: (predicate: Predicate) => Instance;
  findAll: (predicate: Predicate, options?: FindOptions) => Instance[];
  findByType: (type: ElementType | string) => Instance;
  findAllByType: (type: ElementType | string, options?: FindOptions) => Instance[];
  findByProps: (props: Record<string, unknown>) => Instance;
  findAllByProps: (props: Record<string, unknown>, options?: FindOptions) => Instance[];
};

type Renderer = {
  root: Instance;
  update: (element: ReactElement) => void;
  unmount: () => void;
  toJSON: () => JsonElement | JsonElement[] | null;
};

export type { Instance as ReactTestInstance, Renderer as ReactTestRenderer };

function only(nodes: Instance[]): Instance {
  const node = nodes[0];
  if (nodes.length !== 1 || !node) {
    throw new Error(`Expected one matching instance, received ${nodes.length}`);
  }
  return node;
}

function matchesProps(node: Instance, props: Record<string, unknown>): boolean {
  return Object.entries(props).every(([key, value]) => node.props[key] === value);
}

function createTree(root: Root): () => Instance {
  const cache = new WeakMap<Fiber, Instance>();
  let currentFibers = new Set<Fiber>();
  let rootState: { current: Fiber } | undefined = undefined;

  function refresh(): void {
    const tree = rootState?.current;
    if (!tree) {
      return;
    }
    currentFibers = new Set<Fiber>();
    function visit(node: Fiber | null): void {
      for (let item = node; item; item = item.sibling) {
        currentFibers.add(item);
        visit(item.child);
      }
    }
    visit(tree);
  }

  function wrap(fiber: Fiber): Instance {
    const cached = cache.get(fiber) ?? (fiber.alternate && cache.get(fiber.alternate));
    if (cached) {
      return cached;
    }
    const current = () => {
      refresh();
      return currentFibers.has(fiber) || !fiber.alternate ? fiber : fiber.alternate;
    };
    const node: Instance = {
      get type() {
        return current().type as ElementType;
      },
      get props() {
        return current().memoizedProps ?? {};
      },
      get parent() {
        let parent = current().return;
        if (parent?.type === 'TestRoot') {
          return null;
        }
        while (parent && !parent.type) {
          parent = parent.return;
        }
        return parent ? wrap(parent) : null;
      },
      get children() {
        const active = current();
        return children(active.tag === 3 ? (active.child?.child ?? null) : active.child);
      },
      find: predicate => only(node.findAll(predicate, { deep: false })),
      findAll: (predicate, options) => {
        const matched = predicate(node);
        if (matched && options?.deep === false) {
          return [node];
        }
        return [
          ...(matched ? [node] : []),
          ...node.children.flatMap(child =>
            typeof child === 'string' ? [] : child.findAll(predicate, options)
          ),
        ];
      },
      findByType: type => only(node.findAllByType(type, { deep: false })),
      findAllByType: (type, options) => node.findAll(child => child.type === type, options),
      findByProps: props => only(node.findAllByProps(props, { deep: false })),
      findAllByProps: (props, options) =>
        node.findAll(child => matchesProps(child, props), options),
    };
    cache.set(fiber, node);
    return node;
  }

  function children(first: Fiber | null): (Instance | string)[] {
    const result: (Instance | string)[] = [];
    for (let child = first; child; child = child.sibling) {
      if (child.tag === 6) {
        result.push(child.memoizedProps as string);
      } else if (child.type && child.tag !== 10) {
        result.push(wrap(child));
      } else {
        result.push(...children(child.child));
      }
    }
    return result;
  }

  return () => {
    const host = root.container.queryAll(() => true)[0];
    let fiber = host?.unstable_fiber;
    if (!fiber) {
      throw new Error('No mounted host instance');
    }
    while (fiber.return) {
      fiber = fiber.return;
    }
    rootState = fiber.stateNode as { current: Fiber };
    refresh();
    const tree = rootState.current;
    const nodes = children(tree.child?.child ?? null);
    const first = nodes[0];
    if (nodes.length === 1 && first && typeof first !== 'string') {
      return first;
    }
    return wrap(tree);
  };
}

// react-test-renderer's default `createNodeMock` handed `null` to a ref on a
// host element, so an imperative call made through a host ref (a component that
// keeps a ref to a host `TextInput` and calls `clear()` on it) was a no-op. The
// maintained renderer exposes its host node to the ref instead. Keep the old
// no-op contract by giving that node the TextInput imperative surface as inert
// methods, so those components keep working without a per-test ref mock.
const HOST_REF_INERT_METHODS: Record<string, (...args: unknown[]) => unknown> = {
  blur: () => undefined,
  clear: () => undefined,
  focus: () => undefined,
  getNativeRef: () => undefined,
  getScrollableNode: () => undefined,
  isFocused: () => false,
  measure: () => undefined,
  measureInWindow: () => undefined,
  measureLayout: () => undefined,
  setNativeProps: () => undefined,
  setSelection: () => undefined,
};

function applyHostRefParity(container: object): void {
  const prototype = Object.getPrototypeOf(container) as Record<string, unknown>;
  for (const [name, method] of Object.entries(HOST_REF_INERT_METHODS)) {
    if (!(name in prototype)) {
      Object.defineProperty(prototype, name, { value: method, configurable: true, writable: true });
    }
  }
}

function create(element: ReactElement): Renderer {
  const root = createRoot();
  applyHostRefParity(root.container);
  const tree = createTree(root);
  // A host anchor exposes the Fiber tree even when the component renders null.
  // It is excluded from queries and serialized output.
  const update = (next: ReactElement) => {
    root.render(createElement('TestRoot', null, next));
  };
  update(element);
  return {
    get root() {
      return tree();
    },
    update,
    unmount: () => {
      act(() => {
        root.unmount();
      });
    },
    toJSON: () => {
      const anchor = root.container.children[0];
      const children =
        anchor && typeof anchor !== 'string' ? (anchor.toJSON()?.children ?? []) : [];
      const elements = children.filter(child => typeof child !== 'string');
      return elements.length <= 1 ? (elements[0] ?? null) : elements;
    },
  };
}

export const TestRenderer = { create, act };

export namespace TestRenderer {
  export type ReactTestInstance = Instance;
  export type ReactTestRenderer = Renderer;
  export type ReactTestRendererJSON = JsonElement;
}
