import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { GitHubRepositoryCustomizations as GitHubRepositoryCustomizationsComponent } from './GitHubRepositoryCustomizationsPreview';
import type { ModelOption } from '@/components/shared/ModelCombobox';

jest.mock('lucide-react', () => new Proxy({}, { get: () => () => null }));
jest.mock('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
}));
jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));
jest.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    'aria-label': ariaLabel,
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    createElement(
      'button',
      { type: 'button', onClick, disabled, 'aria-label': ariaLabel },
      children
    ),
}));
jest.mock('@/components/ui/input', () => ({
  Input: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) =>
    createElement('input', { ...props, onInput: onChange }),
}));
jest.mock('@/components/ui/label', () => ({
  Label: (props: React.LabelHTMLAttributes<HTMLLabelElement>) => createElement('label', props),
}));
jest.mock('@/components/ui/collapsible', () => {
  const Context = React.createContext({ open: false, toggle: () => {} });
  return {
    Collapsible: ({
      defaultOpen = false,
      children,
    }: {
      defaultOpen?: boolean;
      children: React.ReactNode;
    }) => {
      const [open, setOpen] = React.useState(defaultOpen);
      return createElement(
        Context.Provider,
        { value: { open, toggle: () => setOpen(value => !value) } },
        children
      );
    },
    CollapsibleTrigger: ({
      children,
    }: {
      children: React.ReactElement<{ onClick: () => void }>;
    }) => {
      const { toggle } = React.useContext(Context);
      return React.cloneElement(children, { onClick: toggle });
    },
    CollapsibleContent: ({ children }: { children: React.ReactNode }) =>
      React.useContext(Context).open ? createElement('div', {}, children) : null,
  };
});
jest.mock('@/components/ui/sheet', () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? createElement('div', {}, children) : null,
  SheetContent: ({ children }: { children: React.ReactNode }) =>
    createElement('div', { role: 'dialog' }, children),
  SheetHeader: ({ children }: { children: React.ReactNode }) =>
    createElement('header', {}, children),
  SheetTitle: ({ children }: { children: React.ReactNode }) => createElement('h2', {}, children),
  SheetDescription: ({ children }: { children: React.ReactNode }) =>
    createElement('p', {}, children),
  SheetFooter: ({ children }: { children: React.ReactNode }) =>
    createElement('footer', {}, children),
}));
jest.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    disabled,
    onValueChange,
    children,
  }: {
    value: string;
    disabled?: boolean;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
  }) => {
    const trigger = React.Children.toArray(children).find(
      child => React.isValidElement<{ id?: string }>(child) && child.props.id
    );
    const id = React.isValidElement<{ id?: string }>(trigger) ? trigger.props.id : undefined;
    return createElement(
      'select',
      {
        id,
        value,
        disabled,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
          onValueChange(event.currentTarget.value),
      },
      children
    );
  },
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) =>
    createElement(React.Fragment, {}, children),
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) =>
    createElement('option', { value }, children),
}));
jest.mock('@/components/shared/ModelCombobox', () => ({
  ModelCombobox: ({
    id,
    value,
    models,
    label,
    triggerAriaLabel,
    disabled,
    onValueChange,
  }: {
    id: string;
    value: string;
    models: ModelOption[];
    label: string;
    triggerAriaLabel?: string;
    disabled?: boolean;
    onValueChange: (value: string) => void;
  }) =>
    createElement(
      'select',
      {
        id,
        value,
        disabled,
        'aria-label': triggerAriaLabel ?? label,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
          onValueChange(event.currentTarget.value),
      },
      models.map(model => createElement('option', { key: model.id, value: model.id }, model.name))
    ),
}));

type RepositoryCustomization = {
  id: number;
  name: string;
  private: boolean;
  model: string | null;
  prReviews: 'on' | 'off' | null;
};

type RepositoryCustomizationsData = {
  id: string;
  account: string | null;
  access: 'all' | 'selected';
  defaultModel: string;
  defaultPrReviews: 'on' | 'off';
  repositories: RepositoryCustomization[];
};

function createRepositoryCustomizationsData(): RepositoryCustomizationsData {
  return {
    id: 'first',
    account: 'first',
    access: 'all',
    defaultModel: 'model-a',
    defaultPrReviews: 'on',
    repositories: [
      {
        id: 1,
        name: 'first/api',
        private: true,
        model: 'model-b',
        prReviews: 'off',
      },
      {
        id: 2,
        name: 'first/docs',
        private: false,
        model: 'model-a',
        prReviews: 'off',
      },
      {
        id: 3,
        name: 'first/billing',
        private: true,
        model: null,
        prReviews: 'on',
      },
      ...Array.from({ length: 9 }, (_, index) => ({
        id: 4 + index,
        name: `first/repo-${index}`,
        private: true,
        model: null,
        prReviews: null,
      })),
    ],
  };
}

const models: ModelOption[] = [
  { id: 'model-a', name: 'Model A' },
  { id: 'model-b', name: 'Model B' },
];

let mockRepositoryCustomizationsData: RepositoryCustomizationsData | undefined;
let mockListIntegrationsError: Error | undefined;
let mockGetRepositoryCustomizationsError: Error | undefined;
const mockUpdateInstallationSettingsMutateAsync =
  jest.fn<(variables: unknown) => Promise<{ success: boolean; error?: string }>>();
const mockUpdateRepositorySettingsMutateAsync =
  jest.fn<(variables: unknown) => Promise<{ success: boolean; error?: string }>>();
const mockListIntegrationsRefetch = jest.fn();
const mockGetRepositoryCustomizationsRefetch = jest.fn();
const mockSetQueryData = jest.fn(
  (
    _queryKey: unknown,
    updater: (
      current: RepositoryCustomizationsData | undefined
    ) => RepositoryCustomizationsData | undefined
  ) => {
    mockRepositoryCustomizationsData = updater(mockRepositoryCustomizationsData);
  }
);

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    githubApps: {
      listIntegrations: {
        queryOptions: () => ({ __tag: 'listIntegrations' }),
      },
      getRepositoryCustomizations: {
        queryOptions: () => ({ __tag: 'getRepositoryCustomizations' }),
        queryKey: (input: unknown) => ['githubApps.getRepositoryCustomizations', input],
      },
      updateInstallationSettings: {
        mutationOptions: () => ({ __tag: 'updateInstallationSettings' }),
      },
      updateRepositorySettings: {
        mutationOptions: () => ({ __tag: 'updateRepositorySettings' }),
      },
    },
  }),
}));

jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: { __tag: string }) => {
    if (options.__tag === 'listIntegrations') {
      return {
        data: mockListIntegrationsError ? undefined : [{ id: 'first' }],
        isLoading: false,
        isError: mockListIntegrationsError !== undefined,
        error: mockListIntegrationsError,
        refetch: mockListIntegrationsRefetch,
      };
    }
    if (options.__tag === 'getRepositoryCustomizations') {
      return {
        data: mockGetRepositoryCustomizationsError ? undefined : mockRepositoryCustomizationsData,
        isLoading: false,
        isError: mockGetRepositoryCustomizationsError !== undefined,
        error: mockGetRepositoryCustomizationsError,
        refetch: mockGetRepositoryCustomizationsRefetch,
      };
    }
    throw new Error(`Unexpected query tag: ${options.__tag}`);
  },
  useMutation: (options: { __tag: string }) => {
    if (options.__tag === 'updateInstallationSettings') {
      return { mutateAsync: mockUpdateInstallationSettingsMutateAsync };
    }
    if (options.__tag === 'updateRepositorySettings') {
      return { mutateAsync: mockUpdateRepositorySettingsMutateAsync };
    }
    throw new Error(`Unexpected mutation tag: ${options.__tag}`);
  },
  useQueryClient: () => ({ setQueryData: mockSetQueryData }),
}));

type LinkedomModule = {
  parseHTML: (html: string) => {
    window: Record<string, unknown>;
    document: Document;
  };
};

function installDom() {
  const requireFromNext = createRequire(createRequire(__filename).resolve('next/package.json'));
  const { window, document } = (requireFromNext('linkedom') as LinkedomModule).parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const values: Record<string, unknown> = {
    React,
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of ['HTMLElement', 'Element', 'Node', 'Event']) values[name] = window[name];
  const previous = new Map(
    Object.keys(values).map(name => [name, Object.getOwnPropertyDescriptor(globals, name)])
  );
  Object.assign(globals, values);
  const container = document.getElementById('root');
  if (!container) throw new Error('linkedom root missing');
  return {
    container,
    cleanup: () =>
      previous.forEach((descriptor, name) => {
        if (descriptor) Object.defineProperty(globals, name, descriptor);
        else Reflect.deleteProperty(globals, name);
      }),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

let GitHubRepositoryCustomizations: typeof GitHubRepositoryCustomizationsComponent;

beforeEach(async () => {
  jest.clearAllMocks();
  mockRepositoryCustomizationsData = createRepositoryCustomizationsData();
  mockListIntegrationsError = undefined;
  mockGetRepositoryCustomizationsError = undefined;
  mockUpdateInstallationSettingsMutateAsync.mockResolvedValue({
    success: true,
  });
  mockUpdateRepositorySettingsMutateAsync.mockResolvedValue({ success: true });
  ({ GitHubRepositoryCustomizations } = await import('./GitHubRepositoryCustomizationsPreview'));
});

describe('GitHubRepositoryCustomizations (live)', () => {
  let root: Root | undefined;
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    cleanup?.();
    cleanup = undefined;
  });

  function render() {
    const dom = installDom();
    cleanup = dom.cleanup;
    root = createRoot(dom.container);
    act(() => {
      root?.render(
        createElement(GitHubRepositoryCustomizations, {
          scope: 'personal',
          organizationName: 'Test team',
          models,
        })
      );
    });
    return { container: dom.container };
  }

  function find<T extends Element>(container: ParentNode, selector: string): T {
    const element = container.querySelector<T>(selector);
    if (!element) throw new Error(`Missing element: ${selector}`);
    return element;
  }

  function button(container: ParentNode, name: string): HTMLButtonElement {
    const element = Array.from(container.querySelectorAll('button')).find(
      candidate => (candidate.getAttribute('aria-label') ?? candidate.textContent?.trim()) === name
    );
    if (!element) throw new Error(`Missing button: ${name}`);
    return element;
  }

  async function click(element: HTMLElement) {
    await act(async () => {
      element.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function select(container: ParentNode, id: string, value: string) {
    const element = find<HTMLSelectElement>(container, `select[id="${id}"]`);
    const options = Array.from(element.options);
    const selected = options.find(option => option.value === value);
    if (!selected) throw new Error(`Missing option: ${value}`);
    await act(async () => {
      for (const option of options) option.selected = false;
      selected.selected = true;
      element.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function row(container: ParentNode, name: string) {
    const element = Array.from(container.querySelectorAll('tbody tr')).find(
      candidate => candidate.querySelector('[title]')?.getAttribute('title') === name
    );
    if (!element) throw new Error(`Missing repository row: ${name}`);
    return element;
  }

  function chooseModelSource(container: ParentNode, custom: boolean) {
    const radio =
      container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[custom ? 1 : 0];
    if (!radio) throw new Error('Missing model source radio');
    act(() => {
      radio.checked = true;
      radio.dispatchEvent(new Event('click', { bubbles: true }));
    });
  }

  it('renders installation defaults and repository overrides from the query', () => {
    const { container } = render();
    expect(container.textContent).toContain('All repositories');
    expect(row(container, 'first/api').textContent).toContain('PR reviews: Off');
    expect(row(container, 'first/repo-0').textContent).toContain('Using integration defaults');
  });

  it('saves a repository override and patches the cache with the persisted value', async () => {
    const { container } = render();
    await click(button(container, 'Edit first/repo-0'));
    const editor = find<HTMLElement>(container, '[role="dialog"]');
    chooseModelSource(editor, true);
    await select(editor, '4-custom-model', 'model-b');
    await click(button(editor, 'Save changes'));

    expect(mockUpdateRepositorySettingsMutateAsync).toHaveBeenCalledWith({
      organizationId: undefined,
      integrationId: 'first',
      repositoryId: 4,
      settings: { modelSlug: 'model-b', prReviewMode: null },
    });
    expect(row(container, 'first/repo-0').textContent).toContain('Model: Model B');
  });

  it('disables the default model control while saving and reverts it if the save fails', async () => {
    const deferred = createDeferred<{ success: boolean }>();
    mockUpdateInstallationSettingsMutateAsync.mockReturnValue(deferred.promise);
    const { container } = render();

    await select(container, 'first-default-model', 'model-b');
    expect(find<HTMLSelectElement>(container, 'select[id="first-default-model"]').value).toBe(
      'model-b'
    );
    expect(find<HTMLSelectElement>(container, 'select[id="first-default-model"]').disabled).toBe(
      true
    );

    await act(async () => {
      deferred.resolve({ success: false });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(find<HTMLSelectElement>(container, 'select[id="first-default-model"]').disabled).toBe(
      false
    );
    expect(find<HTMLSelectElement>(container, 'select[id="first-default-model"]').value).toBe(
      'model-a'
    );
    expect(mockSetQueryData).not.toHaveBeenCalled();
  });

  it('reports a repository policy rejection without applying the edit', async () => {
    mockUpdateRepositorySettingsMutateAsync.mockResolvedValue({
      success: false,
      error: 'Model is not allowed by organization policy',
    });
    const { container } = render();
    await click(button(container, 'Edit first/repo-0'));
    const editor = find<HTMLElement>(container, '[role="dialog"]');
    chooseModelSource(editor, true);
    await select(editor, '4-custom-model', 'model-b');
    await click(button(editor, 'Save changes'));

    expect(row(container, 'first/repo-0').textContent).toContain('Using integration defaults');
    expect(mockSetQueryData).not.toHaveBeenCalled();
    const { toast } = jest.requireMock<{ toast: { error: jest.Mock } }>('sonner');
    expect(toast.error).toHaveBeenCalledWith('Model is not allowed by organization policy');
  });

  it('re-enables the Edit button once a repository save settles', async () => {
    const deferred = createDeferred<{ success: boolean }>();
    mockUpdateRepositorySettingsMutateAsync.mockReturnValue(deferred.promise);
    const { container } = render();
    await click(button(container, 'Edit first/repo-0'));
    const editor = find<HTMLElement>(container, '[role="dialog"]');
    chooseModelSource(editor, true);
    await select(editor, '4-custom-model', 'model-b');
    await click(button(editor, 'Save changes'));

    expect(button(container, 'Edit first/repo-0').disabled).toBe(true);

    await act(async () => {
      deferred.resolve({ success: true });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(button(container, 'Edit first/repo-0').disabled).toBe(false);
  });

  it('shows a retryable error instead of an endless loading state when the customizations query fails', async () => {
    mockGetRepositoryCustomizationsError = new Error('Request failed');
    const { container } = render();

    expect(container.textContent).not.toContain('Loading repository customizations…');
    expect(container.textContent).toContain(
      'Couldn’t load repository customizations: Request failed'
    );

    await click(button(container, 'Retry'));
    expect(mockGetRepositoryCustomizationsRefetch).toHaveBeenCalledTimes(1);
  });

  it('shows a retryable error for the installations list when it fails to load', async () => {
    mockListIntegrationsError = new Error('Request failed');
    const { container } = render();

    expect(container.textContent).not.toContain('Loading installations…');
    expect(container.textContent).toContain(
      'Couldn’t load GitHub App installations: Request failed'
    );
    expect(container.textContent).not.toContain('No GitHub App installations found.');

    await click(button(container, 'Retry'));
    expect(mockListIntegrationsRefetch).toHaveBeenCalledTimes(1);
  });
});
