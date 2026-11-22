/**
 * The form keeps a `draft` the user edits and a `baseline` loaded from the
 * server. A repository absent from the cached workspace, or a reasoning level
 * the selected model does not offer, is reported to the user and stays in the
 * draft until they act: the form shows saved state, saving and enabling stay
 * unavailable, and the user's own confirmation applies the change.
 *
 * The network boundary (trpc options, react-query hooks, org models) is mocked
 * so these tests only exercise the component's own bookkeeping.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement, type ComponentProps } from 'react';
import type { createRoot as createReactRoot, Root } from 'react-dom/client';
import type { BitbucketReviewConfigForm as BitbucketReviewConfigFormComponent } from './BitbucketReviewConfigForm';

const LISTED_REPOSITORY_ID = '11111111-1111-4111-8111-111111111111';
const UNAVAILABLE_REPOSITORY_ID = '22222222-2222-4222-8222-222222222222';
const DEFAULT_MODEL_SLUG = 'anthropic/claude-sonnet-4';
const ORGANIZATION_ID = 'org-test';

type ConfigPayload = {
  isEnabled: boolean;
  reviewStyle: string;
  focusAreas: string[];
  customInstructions: string | null;
  modelSlug: string;
  thinkingEffort: string | null;
  selectedRepositoryIds: string[];
};

type CachedRepository = { id: string; name: string; fullName: string; private: boolean };

type RepositoryCache = {
  status: 'available' | 'uninitialized' | 'temporarily_unavailable';
  repositories: CachedRepository[];
  syncedAt: string | null;
};

type ReadinessPayload = {
  ready: boolean;
  canManage: boolean;
  connected: boolean;
  integrationId: string | null;
  missingRequiredScopes: string[];
  canTriggerManualReview: boolean;
  repositoryCache: RepositoryCache;
};

type ModelOption = { id: string; name: string; variants: string[] };

const listedRepository: CachedRepository = {
  id: LISTED_REPOSITORY_ID,
  name: 'repo-one',
  fullName: 'fake-workspace/repo-one',
  private: false,
};

const defaultConfig: ConfigPayload = {
  isEnabled: false,
  reviewStyle: 'balanced',
  focusAreas: [],
  customInstructions: null,
  modelSlug: DEFAULT_MODEL_SLUG,
  thinkingEffort: null,
  selectedRepositoryIds: [],
};

const defaultReadiness: ReadinessPayload = {
  ready: true,
  canManage: true,
  connected: true,
  integrationId: 'integration-1',
  missingRequiredScopes: [],
  canTriggerManualReview: false,
  repositoryCache: { status: 'available', repositories: [listedRepository], syncedAt: null },
};

/* ------------------------------------------------------------------ */
/* Query and mutation routing                                          */
/* ------------------------------------------------------------------ */

// `queryOptions` returns a fresh object carrying an explicit route tag, and the
// mocked `useQuery` refuses anything it cannot route, so config and readiness
// can never be swapped silently.
type QueryRoute = 'config' | 'readiness';

type QueryState = { data: unknown; isLoading: boolean; error: Error | null };

const queryStates: Record<QueryRoute, QueryState> = {
  config: { data: defaultConfig, isLoading: false, error: null },
  readiness: { data: defaultReadiness, isLoading: false, error: null },
};

type MockMutationOptions = { mutationFn?: (variables: unknown) => Promise<unknown> };

const mockSave = jest.fn<(variables: unknown) => Promise<unknown>>();
const mockToggle = jest.fn<(variables: unknown) => Promise<unknown>>();
const mockRefreshRepositories = jest.fn<(variables: unknown) => Promise<unknown>>();
const mockTriggerReview = jest.fn<(variables: unknown) => Promise<unknown>>();
const mockInvalidateQueries = jest.fn<(...args: unknown[]) => Promise<void>>();
const mockToast = { success: jest.fn(), error: jest.fn() };

function routeQuery(options: { __query?: QueryRoute } | undefined): QueryState {
  const route = options?.__query;
  if (!route) throw new Error('useQuery received an unrouted options object');
  return queryStates[route];
}

const mockTrpc = {
  organizations: {
    reviewAgent: {
      getReviewConfig: {
        queryOptions: () => ({ queryKey: ['reviewAgent.getReviewConfig'], __query: 'config' }),
      },
      getBitbucketReadiness: {
        queryOptions: () => ({
          queryKey: ['reviewAgent.getBitbucketReadiness'],
          __query: 'readiness',
        }),
      },
      saveReviewConfig: {
        mutationOptions: (options: MockMutationOptions) => ({ ...options, mutationFn: mockSave }),
      },
      toggleReviewAgent: {
        mutationOptions: (options: MockMutationOptions) => ({ ...options, mutationFn: mockToggle }),
      },
      triggerBitbucketCodeReview: {
        mutationOptions: (options: MockMutationOptions) => ({
          ...options,
          mutationFn: mockTriggerReview,
        }),
      },
    },
    bitbucket: {
      getStatus: { queryKey: () => ['organizations.bitbucket.getStatus'] },
      refreshRepositories: {
        mutationOptions: (options: MockMutationOptions) => ({
          ...options,
          mutationFn: mockRefreshRepositories,
        }),
      },
    },
    cloudAgentNext: {
      listBitbucketRepositories: { queryKey: () => ['cloudAgentNext.listBitbucketRepositories'] },
    },
  },
  codeReviews: {
    listForOrganization: { pathFilter: () => ({ queryKey: ['codeReviews.listForOrganization'] }) },
  },
};

jest.mock('@/lib/trpc/utils', () => ({ useTRPC: () => mockTrpc }));

jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: { __query?: QueryRoute }) => {
    const state = routeQuery(options);
    return {
      data: state.data,
      isLoading: state.isLoading,
      isError: state.error !== null,
      error: state.error,
      refetch: () => Promise.resolve(undefined),
    };
  },
  useMutation: (options: MockMutationOptions | undefined) => ({
    isPending: false,
    error: null,
    data: undefined,
    mutate: (variables: unknown) => {
      void options?.mutationFn?.(variables);
    },
    mutateAsync: (variables: unknown) => options?.mutationFn?.(variables),
  }),
  useQueryClient: () => ({
    invalidateQueries: (...args: unknown[]) => mockInvalidateQueries(...args),
    refetchQueries: () => Promise.resolve(undefined),
  }),
}));

const modelState: { modelOptions: ModelOption[]; isLoadingModels: boolean } = {
  modelOptions: [{ id: DEFAULT_MODEL_SLUG, name: 'Claude Sonnet 4', variants: [] }],
  isLoadingModels: false,
};

jest.mock('@/components/cloud-agent/hooks/useOrganizationModels', () => ({
  useOrganizationModels: () => ({
    modelOptions: modelState.modelOptions,
    isLoadingModels: modelState.isLoadingModels,
    defaultModel: undefined,
  }),
}));

jest.mock('@/components/code-reviews/CodeReviewComputeNotice', () => ({
  CodeReviewComputeNotice: () => createElement('div', { 'data-testid': 'compute-notice' }),
}));

jest.mock('@/components/shared/ModelCombobox', () => ({
  ModelCombobox: ({
    value,
    models,
    onValueChange,
  }: {
    value: string;
    models: { id: string }[];
    onValueChange: (modelSlug: string) => void;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'model-combobox', 'data-value': value },
      models.map(model =>
        createElement(
          'button',
          {
            key: model.id,
            type: 'button',
            'data-model-id': model.id,
            onClick: () => onValueChange(model.id),
          },
          model.id
        )
      )
    ),
}));

// Radix Select portals its items and opens on pointerdown, neither of which
// linkedom supports. The mock renders every item inline and calls the injected
// `onValueChange` on click, which is the only behaviour the form relies on.
type SelectInjectedProps = { onValueChange?: (value: string) => void };

function withSelectProps(children: React.ReactNode, props: SelectInjectedProps): React.ReactNode {
  return React.Children.map(children, child =>
    React.isValidElement<SelectInjectedProps>(child) ? React.cloneElement(child, props) : child
  );
}

jest.mock('@/components/ui/select', () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value: string;
    onValueChange: (value: string) => void;
  }) =>
    createElement(
      'div',
      { 'data-select-value': value },
      withSelectProps(children, { onValueChange })
    ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) =>
    createElement('button', { type: 'button', role: 'combobox' }, children),
  SelectValue: ({ children }: { children: React.ReactNode }) =>
    createElement('span', null, children),
  SelectContent: ({
    children,
    onValueChange,
  }: { children: React.ReactNode } & SelectInjectedProps) =>
    createElement('div', { role: 'listbox' }, withSelectProps(children, { onValueChange })),
  SelectItem: ({
    children,
    value,
    disabled,
    onValueChange,
  }: {
    children: React.ReactNode;
    value: string;
    disabled?: boolean;
  } & SelectInjectedProps) =>
    createElement(
      'button',
      {
        type: 'button',
        role: 'option',
        'data-value': value,
        disabled,
        onClick: () => onValueChange?.(value),
      },
      children
    ),
}));

jest.mock('sonner', () => ({ toast: mockToast }));

jest.mock('next/link', () => ({
  __esModule: true,
  default: (props: ComponentProps<'a'>) => createElement('a', props),
}));

/* ------------------------------------------------------------------ */
/* DOM + act helpers                                                   */
/* ------------------------------------------------------------------ */

type LinkedomModule = {
  parseHTML: (
    html: string,
    globals: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> & { location: URL }
  ) => { window: typeof globalThis; document: Document };
};

type InstalledDom = {
  container: HTMLElement;
  window: typeof globalThis;
  cleanup: () => void;
};

function installDom(): InstalledDom {
  const requireFromHere = createRequire(__filename);
  const linkedom = requireFromHere('linkedom') as LinkedomModule;
  const { window, document } = linkedom.parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { setTimeout, clearTimeout, location: new URL('http://localhost/') }
  );
  const container = document.getElementById('root');
  if (!container) throw new Error('React root missing');
  document.oninput = null;

  // linkedom implements no `checked` accessor; @radix-ui/react-switch reads the
  // setter off the input prototype and throws without one.
  const inputPrototype = window.HTMLInputElement.prototype;
  const checkedDescriptor = Object.getOwnPropertyDescriptor(inputPrototype, 'checked');
  Object.defineProperty(inputPrototype, 'checked', {
    configurable: true,
    get(this: HTMLInputElement) {
      return this.hasAttribute('checked');
    },
    set(this: HTMLInputElement, checked: boolean) {
      this.toggleAttribute('checked', checked);
    },
  });

  // @radix-ui/react-use-size constructs a ResizeObserver in a layout effect.
  class InertResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  // React's scheduler looks these up on `window` when it unmounts.
  const requestAnimationFrame = (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0) as unknown as number;
  const cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  window.requestAnimationFrame = requestAnimationFrame;
  window.cancelAnimationFrame = cancelAnimationFrame;

  const globals: Record<string, unknown> = {
    ResizeObserver: InertResizeObserver,
    requestAnimationFrame,
    cancelAnimationFrame,
    React,
    window,
    document,
    HTMLElement: window.HTMLElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    Text: window.Text,
    Comment: window.Comment,
    DocumentFragment: window.DocumentFragment,
    Document: window.Document,
    SVGElement: window.SVGElement,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  );
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  return {
    container,
    window,
    cleanup: () => {
      if (checkedDescriptor) {
        Object.defineProperty(inputPrototype, 'checked', checkedDescriptor);
      } else {
        Reflect.deleteProperty(inputPrototype, 'checked');
      }
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

/** Flush effects, timers, and their follow-on state updates. */
async function flush(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
  }
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('BitbucketReviewConfigForm', () => {
  let dom: InstalledDom;
  let root: Root | undefined;
  let createRoot: typeof createReactRoot;
  let Component: typeof BitbucketReviewConfigFormComponent;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    modelState.modelOptions = [{ id: DEFAULT_MODEL_SLUG, name: 'Claude Sonnet 4', variants: [] }];
    modelState.isLoadingModels = false;
    dom = installDom();
    // Loaded after the module mocks are registered: @swc/jest does not hoist
    // jest.mock above static imports in this setup.
    ({ createRoot } = await import('react-dom/client'));
    ({ BitbucketReviewConfigForm: Component } = await import('./BitbucketReviewConfigForm'));
  });

  afterEach(async () => {
    try {
      if (root) {
        const mounted = root;
        root = undefined;
        await act(async () => {
          mounted.unmount();
        });
      }
    } finally {
      try {
        dom.cleanup();
      } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    }
  });

  type RenderOverrides = {
    config?: Partial<ConfigPayload>;
    readiness?: Partial<Omit<ReadinessPayload, 'repositoryCache'>> & {
      repositoryCache?: RepositoryCache;
    };
    modelOptions?: ModelOption[];
  };

  async function render(overrides: RenderOverrides = {}) {
    if (root) {
      const mounted = root;
      root = undefined;
      await act(async () => {
        mounted.unmount();
      });
    }
    const readiness = overrides.readiness ?? {};
    queryStates.config = {
      data: { ...defaultConfig, ...overrides.config },
      isLoading: false,
      error: null,
    };
    queryStates.readiness = {
      data: {
        ...defaultReadiness,
        ...readiness,
        repositoryCache: readiness.repositoryCache ?? defaultReadiness.repositoryCache,
      },
      isLoading: false,
      error: null,
    };
    if (overrides.modelOptions) modelState.modelOptions = overrides.modelOptions;

    root = createRoot(dom.container);
    await act(async () => {
      root?.render(createElement(Component, { organizationId: ORGANIZATION_ID }));
    });
    await flush();
  }

  /** A cache holding both the listed and the unavailable stored repository. */
  const cacheWithEveryStoredRepository: RepositoryCache = {
    status: 'available',
    repositories: [
      listedRepository,
      {
        id: UNAVAILABLE_REPOSITORY_ID,
        name: 'repo-two',
        fullName: 'fake-workspace/repo-two',
        private: false,
      },
    ],
    syncedAt: null,
  };

  function click(element: Element) {
    return act(async () => {
      element.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    });
  }

  function mainForm() {
    const form = dom.container.querySelector('form');
    if (!form) throw new Error('Main form missing');
    return form;
  }

  function saveButton() {
    const button = mainForm().querySelector('button[type="submit"]');
    if (!button) throw new Error('Save button missing');
    return button as HTMLButtonElement;
  }

  function enableSwitch() {
    const element = dom.container.querySelector('#bitbucket-code-reviewer-enabled');
    if (!element) throw new Error('Enable switch missing');
    return element as HTMLButtonElement;
  }

  function statusText() {
    return dom.container.querySelector('[aria-live="polite"]')?.textContent?.trim() ?? '';
  }

  function enableHint() {
    return (
      dom.container.querySelector('#bitbucket-code-reviewer-enable-hint')?.textContent?.trim() ?? ''
    );
  }

  function alertTitles() {
    return Array.from(dom.container.querySelectorAll('[data-slot="alert-title"]')).map(
      title => title.textContent?.trim() ?? ''
    );
  }

  function buttonWithText(text: string) {
    const button = Array.from(dom.container.querySelectorAll('button')).find(candidate =>
      (candidate.textContent ?? '').includes(text)
    );
    if (!button) throw new Error(`Button containing "${text}" missing`);
    return button as HTMLButtonElement;
  }

  function removalButton() {
    return buttonWithText('Remove unavailable repositories');
  }

  function repositoryFooter() {
    const matches = Array.from(dom.container.querySelectorAll('div')).filter(node =>
      /\d+ of \d+ repositories selected/.test(node.textContent ?? '')
    );
    // Ancestors repeat the same text; the deepest match is the footer itself.
    const footer = matches.sort(
      (left, right) => (left.textContent?.length ?? 0) - (right.textContent?.length ?? 0)
    )[0];
    return footer?.textContent?.trim() ?? '';
  }

  function reviewStyleButton(value: string) {
    const button = dom.container.querySelector(`#bitbucket-review-style-${value}`);
    if (!button) throw new Error(`Review style ${value} missing`);
    return button;
  }

  function modelButton(modelSlug: string) {
    const button = dom.container.querySelector(`[data-model-id="${modelSlug}"]`);
    if (!button) throw new Error(`Model ${modelSlug} missing`);
    return button;
  }

  function thinkingEffortOptions() {
    return Array.from(dom.container.querySelectorAll('[role="option"]')).map(option => ({
      value: option.getAttribute('data-value') ?? '',
      label: option.textContent?.trim() ?? '',
      disabled: (option as HTMLButtonElement).disabled,
    }));
  }

  it('reports a stored repository that left the cache without touching the draft', async () => {
    await render({
      config: { selectedRepositoryIds: [LISTED_REPOSITORY_ID, UNAVAILABLE_REPOSITORY_ID] },
    });

    expect(statusText()).toBe('All changes saved');
    expect(saveButton().disabled).toBe(true);
    expect(alertTitles()).toContain('1 selected repository is no longer available');
    expect(repositoryFooter()).toBe('1 of 1 repositories selected');
  });

  it('keeps the enable switch disabled until the stale selection is removed', async () => {
    await render({
      config: { selectedRepositoryIds: [LISTED_REPOSITORY_ID, UNAVAILABLE_REPOSITORY_ID] },
    });

    expect(enableSwitch().disabled).toBe(true);
    expect(enableHint()).toContain('Remove the selected repositories');

    // The same stored selection with a cache that still lists both repositories
    // is enable-able, which is what the removal action restores.
    await render({
      config: { selectedRepositoryIds: [LISTED_REPOSITORY_ID, UNAVAILABLE_REPOSITORY_ID] },
      readiness: { repositoryCache: cacheWithEveryStoredRepository },
    });

    expect(enableSwitch().disabled).toBe(false);
    expect(alertTitles()).toEqual([]);
  });

  it('applies the removal as a user edit', async () => {
    await render({
      config: { selectedRepositoryIds: [LISTED_REPOSITORY_ID, UNAVAILABLE_REPOSITORY_ID] },
    });

    await click(removalButton());
    await flush();

    expect(statusText()).toBe('Unsaved changes');
    expect(saveButton().disabled).toBe(false);
    expect(alertTitles()).toEqual([]);
    expect(repositoryFooter()).toBe('1 of 1 repositories selected');
  });

  it('marks the form dirty for an unrelated edit', async () => {
    await render({
      config: { selectedRepositoryIds: [LISTED_REPOSITORY_ID, UNAVAILABLE_REPOSITORY_ID] },
      readiness: { repositoryCache: cacheWithEveryStoredRepository },
    });
    expect(statusText()).toBe('All changes saved');

    await click(reviewStyleButton('strict'));
    await flush();

    expect(statusText()).toBe('Unsaved changes');
  });

  it('shows a stored reasoning level the model dropped as unavailable', async () => {
    await render({
      config: {
        selectedRepositoryIds: [LISTED_REPOSITORY_ID],
        thinkingEffort: 'low',
      },
      modelOptions: [{ id: DEFAULT_MODEL_SLUG, name: 'Claude Sonnet 4', variants: ['high'] }],
    });

    expect(statusText()).toBe('All changes saved');
    expect(thinkingEffortOptions()).toEqual([
      { value: '__default__', label: 'Default', disabled: false },
      { value: 'high', label: 'High', disabled: false },
      { value: 'low', label: 'Low (unavailable)', disabled: true },
    ]);

    const defaultOption = dom.container.querySelector('[role="option"][data-value="__default__"]');
    if (!defaultOption) throw new Error('Default option missing');
    await click(defaultOption);
    await flush();

    expect(statusText()).toBe('Unsaved changes');
  });

  it('blocks saving while a stale repository id remains selected', async () => {
    await render({
      config: { selectedRepositoryIds: [LISTED_REPOSITORY_ID, UNAVAILABLE_REPOSITORY_ID] },
    });

    await click(reviewStyleButton('strict'));
    await flush();

    expect(statusText()).toBe('Unsaved changes');
    expect(saveButton().disabled).toBe(true);

    // The form-level submit bypasses the disabled button, as Enter in a field
    // would, so the guard itself must hold.
    await act(async () => {
      mainForm().dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(mockSave).not.toHaveBeenCalled();
    const removalMessage = Array.from(dom.container.querySelectorAll('p[role="alert"]')).map(
      node => node.textContent ?? ''
    );
    expect(removalMessage).toContain(
      'Remove the selected repositories that are no longer available before saving changes.'
    );
  });

  it('normalizes the reasoning level when the user switches model', async () => {
    const otherModelSlug = 'anthropic/claude-haiku-4';
    const modelOptions = [
      { id: DEFAULT_MODEL_SLUG, name: 'Claude Sonnet 4', variants: ['max', 'high'] },
      { id: otherModelSlug, name: 'Claude Haiku 4', variants: ['low', 'high'] },
    ];
    await render({
      config: {
        selectedRepositoryIds: [LISTED_REPOSITORY_ID],
        thinkingEffort: 'max',
      },
      modelOptions,
    });
    expect(statusText()).toBe('All changes saved');

    // Mirroring the source model keeps the stored reasoning level.
    await click(modelButton(DEFAULT_MODEL_SLUG));
    await flush();
    expect(thinkingEffortOptions().map(option => option.value)).toContain('max');

    // Moving to a model that does not offer it resets the effort, and that
    // user action is what makes the form dirty.
    await click(modelButton(otherModelSlug));
    await flush();

    expect(
      dom.container.querySelector('[data-testid="model-combobox"]')?.getAttribute('data-value')
    ).toBe(otherModelSlug);
    expect(thinkingEffortOptions().map(option => option.value)).toEqual([
      '__default__',
      'low',
      'high',
    ]);
    expect(statusText()).toBe('Unsaved changes');

    await act(async () => {
      mainForm().dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ modelSlug: otherModelSlug, thinkingEffort: null })
    );
  });

  it('names the removal action when only stale repositories remain selected', async () => {
    await render({
      config: { selectedRepositoryIds: [UNAVAILABLE_REPOSITORY_ID] },
    });

    expect(statusText()).toBe('All changes saved');
    expect(saveButton().disabled).toBe(true);
    expect(alertTitles()).toContain('1 selected repository is no longer available');
    expect(repositoryFooter()).toBe('0 of 1 repositories selected');
    // "Select at least one repository" would be the wrong instruction here:
    // the fix is to remove the stale selection, not to pick a listed one.
    expect(enableHint()).toContain('Remove the selected repositories');
    expect(enableHint()).not.toContain('Select at least one repository');
  });
});
