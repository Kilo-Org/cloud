import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  GitHubRepositoryCustomizationsPreview as PreviewComponent,
  PreviewInstallation,
} from './GitHubRepositoryCustomizationsPreview';
import type { ModelOption } from '@/components/shared/ModelCombobox';

jest.mock('lucide-react', () => new Proxy({}, { get: () => () => null }));
jest.mock('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
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
    onValueChange,
    children,
  }: {
    value: string;
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
    onValueChange,
  }: {
    id: string;
    value: string;
    models: ModelOption[];
    label: string;
    triggerAriaLabel?: string;
    onValueChange: (value: string) => void;
  }) =>
    createElement(
      'select',
      {
        id,
        value,
        'aria-label': triggerAriaLabel ?? label,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
          onValueChange(event.currentTarget.value),
      },
      models.map(model => createElement('option', { key: model.id, value: model.id }, model.name))
    ),
}));

type LinkedomModule = {
  parseHTML: (html: string) => { window: Record<string, unknown>; document: Document };
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

const models: ModelOption[] = [
  { id: 'model-a', name: 'Model A' },
  { id: 'model-b', name: 'Model B' },
];

function createInstallations(): PreviewInstallation[] {
  return [
    {
      id: 'first',
      account: 'first',
      access: 'all',
      defaultModel: 'model-a',
      defaultPrReviews: 'on',
      repositories: [
        {
          id: 'first/api',
          name: 'first/api',
          private: true,
          model: 'model-b',
          prReviews: 'manual',
        },
        {
          id: 'first/docs',
          name: 'first/docs',
          private: false,
          model: 'model-a',
          prReviews: 'off',
        },
        { id: 'first/billing', name: 'first/billing', private: true, model: null, prReviews: 'on' },
        ...Array.from({ length: 9 }, (_, index) => ({
          id: `first/repo-${index}`,
          name: `first/repo-${index}`,
          private: true,
          model: null,
          prReviews: null,
        })),
      ],
    },
    {
      id: 'second',
      account: 'second',
      access: 'selected',
      defaultModel: 'model-b',
      defaultPrReviews: 'manual',
      repositories: [
        {
          id: 'second/research',
          name: 'second/research',
          private: true,
          model: null,
          prReviews: null,
        },
      ],
    },
  ];
}

let Preview: typeof PreviewComponent;

beforeAll(async () => {
  ({ GitHubRepositoryCustomizationsPreview: Preview } =
    await import('./GitHubRepositoryCustomizationsPreview'));
});

describe('GitHub repository customizations preview', () => {
  let root: Root | undefined;
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    cleanup?.();
    cleanup = undefined;
  });

  function render(scope: 'personal' | 'organization' = 'personal') {
    const dom = installDom();
    cleanup = dom.cleanup;
    root = createRoot(dom.container);
    const installations = createInstallations();
    act(() =>
      root?.render(
        createElement(Preview, { scope, organizationName: 'Test team', installations, models })
      )
    );
    return { container: dom.container, installations };
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

  function click(element: HTMLElement) {
    act(() => {
      element.dispatchEvent(new Event('click', { bubbles: true }));
    });
  }

  function select(container: ParentNode, id: string, value: string) {
    const element = find<HTMLSelectElement>(container, `select[id="${id}"]`);
    const options = Array.from(element.options);
    const selected = options.find(option => option.value === value);
    if (!selected) throw new Error(`Missing option: ${value}`);
    act(() => {
      for (const option of options) option.selected = false;
      selected.selected = true;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  function search(container: ParentNode, value: string) {
    const element = find<HTMLInputElement>(container, 'input[type="search"]');
    act(() => {
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
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

  function row(container: ParentNode, name: string) {
    const element = Array.from(container.querySelectorAll('tbody tr')).find(
      candidate => candidate.querySelector('[title]')?.getAttribute('title') === name
    );
    if (!element) throw new Error(`Missing repository row: ${name}`);
    return element;
  }

  it('shows only the personal installation, paginates all-access repositories, and searches across pages', () => {
    const { container } = render();
    expect(container.querySelectorAll('tbody tr')).toHaveLength(10);
    expect(container.textContent).toContain('All repositories');
    expect(container.textContent).not.toContain('second');
    expect(container.querySelector('[id$="configuration-filter"]')).toBeNull();
    expect(container.querySelector('[id$="model-filter"]')).toBeNull();
    expect(button(container, 'Previous page').disabled).toBe(true);
    click(button(container, 'Next page'));
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(container.textContent).toContain('11–12 of 12 repositories');
    expect(button(container, 'Next page').disabled).toBe(true);
    click(button(container, 'Previous page'));
    search(container, 'FIRST/REPO-8');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(row(container, 'first/repo-8')).toBeDefined();
    click(button(container, 'Clear search'));
    expect(container.textContent).toContain('1–10 of 12 repositories');
  });

  it('searches effective models and review settings, including inherited values, and clears empty results', () => {
    const { container } = render();
    search(container, 'model-a');
    expect(container.textContent).toContain('1–10 of 11 repositories');
    expect(row(container, 'first/repo-0').textContent).toContain('Using integration defaults');
    expect(row(container, 'first/docs').textContent).toContain('Model: Model A');
    search(container, 'reviews: manual');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(row(container, 'first/api').textContent).toContain('PR reviews: Manual (@mention)');
    search(container, 'not-a-repository');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(0);
    expect(container.textContent).toContain('No repositories match your search');
    click(button(container, 'Clear search'));
    expect(find<HTMLInputElement>(container, 'input[type="search"]').value).toBe('');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(10);
  });

  it('discards cancelled changes and saves independent model and review overrides', () => {
    const { container } = render();
    click(button(container, 'Edit first/repo-0'));
    let editor = find<HTMLElement>(container, '[role="dialog"]');
    expect(button(editor, 'Save changes').disabled).toBe(true);
    chooseModelSource(editor, true);
    select(editor, 'first/repo-0-custom-model', 'model-b');
    select(editor, 'first/repo-0-reviews', 'manual');
    click(button(editor, 'Cancel'));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(row(container, 'first/repo-0').textContent).toContain('Using integration defaults');
    click(button(container, 'Edit first/repo-0'));
    editor = find<HTMLElement>(container, '[role="dialog"]');
    expect(button(editor, 'Save changes').disabled).toBe(true);
    chooseModelSource(editor, true);
    select(editor, 'first/repo-0-custom-model', 'model-b');
    select(editor, 'first/repo-0-reviews', 'manual');
    click(button(editor, 'Save changes'));
    expect(row(container, 'first/repo-0').textContent).toContain(
      'Model: Model B · PR reviews: Manual (@mention)'
    );
    click(button(container, 'Edit first/repo-0'));
    editor = find<HTMLElement>(container, '[role="dialog"]');
    expect(find<HTMLSelectElement>(editor, 'select[id="first/repo-0-custom-model"]').value).toBe(
      'model-b'
    );
    expect(find<HTMLSelectElement>(editor, 'select[id="first/repo-0-reviews"]').value).toBe(
      'manual'
    );
    expect(button(editor, 'Save changes').disabled).toBe(true);
  });

  it('follows new defaults for inherited values while keeping equal-value overrides pinned', () => {
    const { container } = render();
    select(container, 'first-default-model', 'model-b');
    select(container, 'first-default-reviews', 'off');
    click(button(container, 'Edit first/repo-0'));
    let editor = find<HTMLElement>(container, '[role="dialog"]');
    expect(editor.textContent).toContain('Model B');
    expect(find<HTMLSelectElement>(editor, 'select[id="first/repo-0-reviews"]').value).toBe(
      'default'
    );
    expect(editor.textContent).toContain('Use integration default — Off');
    click(button(editor, 'Cancel'));
    click(button(container, 'Edit first/docs'));
    editor = find<HTMLElement>(container, '[role="dialog"]');
    expect(find<HTMLSelectElement>(editor, 'select[id="first/docs-custom-model"]').value).toBe(
      'model-a'
    );
    click(button(editor, 'Cancel'));
    click(button(container, 'Edit first/billing'));
    editor = find<HTMLElement>(container, '[role="dialog"]');
    expect(find<HTMLSelectElement>(editor, 'select[id="first/billing-reviews"]').value).toBe('on');
    click(button(editor, 'Cancel'));
    expect(row(container, 'first/billing').textContent).toContain('PR reviews: On');
  });

  it('removes overrides when returning to defaults and updates active search results', () => {
    const { container } = render();
    select(container, 'first-default-model', 'model-b');
    search(container, 'docs Model A');
    click(button(container, 'Edit first/docs'));
    const editor = find<HTMLElement>(container, '[role="dialog"]');
    chooseModelSource(editor, false);
    select(editor, 'first/docs-reviews', 'default');
    click(button(editor, 'Save changes'));
    expect(container.querySelectorAll('tbody tr')).toHaveLength(0);
    click(button(container, 'Clear search'));
    expect(row(container, 'first/docs').textContent).toContain('Using integration defaults');
    expect(container.textContent).toContain('2 customized');
  });

  it('isolates organization settings and resets local changes without mutating fixtures', () => {
    const { container, installations } = render('organization');
    const original = structuredClone(installations);
    expect(container.textContent).toContain('1 selected repositories');
    expect(container.querySelector('[aria-label="Edit second/research"]')).toBeNull();
    click(button(container, 'Toggle settings for second'));
    select(container, 'first-default-model', 'model-b');
    select(container, 'first-default-reviews', 'off');
    expect(find<HTMLSelectElement>(container, 'select[id="second-default-model"]').value).toBe(
      'model-b'
    );
    expect(find<HTMLSelectElement>(container, 'select[id="second-default-reviews"]').value).toBe(
      'manual'
    );
    select(container, 'second-default-model', 'model-a');
    expect(find<HTMLSelectElement>(container, 'select[id="first-default-model"]').value).toBe(
      'model-b'
    );
    click(button(container, 'Edit second/research'));
    const editor = find<HTMLElement>(container, '[role="dialog"]');
    select(editor, 'second/research-reviews', 'off');
    click(button(editor, 'Save changes'));
    expect(row(container, 'second/research').textContent).toContain('PR reviews: Off');
    expect(row(container, 'first/api').textContent).toContain('PR reviews: Manual (@mention)');
    click(button(container, 'Reset preview'));
    expect(find<HTMLSelectElement>(container, 'select[id="first-default-model"]').value).toBe(
      'model-a'
    );
    click(button(container, 'Toggle settings for second'));
    expect(row(container, 'second/research').textContent).toContain('Using integration defaults');
    expect(installations).toEqual(original);
  });
});
