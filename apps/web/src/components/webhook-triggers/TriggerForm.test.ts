import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TriggerForm as TriggerFormComponent, TriggerFormProps } from './TriggerForm';

jest.mock('sonner', () => ({ toast: { error: jest.fn(), success: jest.fn() } }));
jest.mock('lucide-react', () => new Proxy({}, { get: () => () => null }));
jest.mock('@/components/ui/card', () => ({
  Card: ({ children }: { children: React.ReactNode }) => createElement('div', {}, children),
  CardContent: ({ children }: { children: React.ReactNode }) => createElement('div', {}, children),
  CardDescription: ({ children }: { children: React.ReactNode }) =>
    createElement('p', {}, children),
  CardHeader: ({ children }: { children: React.ReactNode }) => createElement('div', {}, children),
  CardTitle: ({ children }: { children: React.ReactNode }) => createElement('h2', {}, children),
}));
jest.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    createElement('button', props, children),
}));
jest.mock('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => createElement('input', props),
}));
jest.mock('@/components/ui/textarea', () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) =>
    createElement('textarea', props),
}));
jest.mock('@/components/ui/label', () => ({
  Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) =>
    createElement('label', props, children),
}));
jest.mock('@/components/ui/switch', () => ({ Switch: () => null }));
jest.mock('@/components/ui/checkbox', () => ({ Checkbox: () => null }));
type SelectInjectedProps = {
  onValueChange?: (value: string) => void;
  selectDisabled?: boolean;
};

jest.mock('@/components/ui/select', () => ({
  Select: ({
    children,
    value,
    onValueChange,
    disabled,
  }: {
    children: React.ReactNode;
    value: string;
    onValueChange: (value: string) => void;
    disabled?: boolean;
  }) =>
    createElement(
      'div',
      { 'data-container-allocation': value, 'data-disabled': String(disabled) },
      React.Children.map(children, child => {
        if (!React.isValidElement<SelectInjectedProps>(child)) return child;
        return React.cloneElement(child, { onValueChange, selectDisabled: disabled });
      })
    ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) =>
    createElement(React.Fragment, {}, children),
  SelectValue: () => null,
  SelectContent: ({
    children,
    onValueChange,
    selectDisabled,
  }: {
    children: React.ReactNode;
    onValueChange?: (value: string) => void;
    selectDisabled?: boolean;
  }) =>
    createElement(
      React.Fragment,
      {},
      React.Children.map(children, child => {
        if (!React.isValidElement<SelectInjectedProps>(child)) return child;
        return React.cloneElement(child, { onValueChange, selectDisabled });
      })
    ),
  SelectItem: ({
    children,
    value,
    disabled,
    onValueChange,
    selectDisabled,
  }: {
    children: React.ReactNode;
    value: string;
    disabled?: boolean;
    onValueChange?: (value: string) => void;
    selectDisabled?: boolean;
  }) =>
    createElement(
      'button',
      {
        type: 'button',
        disabled: disabled || selectDisabled,
        onClick: () => onValueChange?.(value),
      },
      children
    ),
}));
jest.mock('@/components/ui/inline-delete-confirmation', () => ({
  InlineDeleteConfirmation: () => null,
}));
jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => createElement('div', {}, children),
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    createElement('div', {}, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) =>
    createElement('p', {}, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) => createElement('div', {}, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) => createElement('div', {}, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) => createElement('h2', {}, children),
}));
jest.mock('@/components/cloud-agent/ProfileSelector', () => ({ ProfileSelector: () => null }));
jest.mock('@/components/shared/RepositoryCombobox', () => ({ RepositoryCombobox: () => null }));
jest.mock('@/components/shared/ModeCombobox', () => ({ ModeCombobox: () => null }));
jest.mock('@/components/shared/ModelCombobox', () => ({
  ModelCombobox: ({
    onValueChange,
    disabled,
  }: {
    onValueChange: (value: string) => void;
    disabled?: boolean;
  }) =>
    createElement(
      'div',
      {},
      createElement(
        'button',
        { type: 'button', disabled, onClick: () => onValueChange('alpha') },
        'alpha'
      ),
      createElement(
        'button',
        { type: 'button', disabled, onClick: () => onValueChange('beta') },
        'beta'
      ),
      createElement(
        'button',
        { type: 'button', disabled, onClick: () => onValueChange('gamma') },
        'gamma'
      )
    ),
}));
jest.mock('@/components/shared/VariantCombobox', () => ({
  VariantCombobox: ({
    value,
    onValueChange,
    onClear,
    disabled,
  }: {
    value?: string;
    onValueChange: (value: string) => void;
    onClear?: () => void;
    disabled?: boolean;
  }) =>
    createElement(
      'div',
      { 'data-variant': value ?? 'unset', 'data-disabled': String(disabled) },
      createElement(
        'button',
        { type: 'button', disabled, onClick: () => onValueChange('high') },
        'high'
      ),
      createElement(
        'button',
        { type: 'button', disabled, onClick: () => onValueChange('none') },
        'none'
      ),
      onClear && createElement('button', { type: 'button', disabled, onClick: onClear }, 'default')
    ),
}));
jest.mock('./ScheduleBuilder', () => ({ ScheduleBuilder: () => null }));
jest.mock('./TimezoneSelector', () => ({ TimezoneSelector: () => null }));

type LinkedomModule = {
  parseHTML: (html: string) => { window: Record<string, unknown>; document: Document };
};

function installDom() {
  const requireFromHere = createRequire(__filename);
  const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));
  const parsed = (requireFromNext('linkedom') as LinkedomModule).parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const previous = new Map<string, unknown>();
  for (const name of [
    'React',
    'window',
    'document',
    'HTMLElement',
    'Element',
    'Node',
    'Event',
    'IS_REACT_ACT_ENVIRONMENT',
  ]) {
    previous.set(name, globals[name]);
  }
  Object.assign(globals, {
    React,
    window: parsed.window,
    document: parsed.document,
    HTMLElement: (parsed.window as { HTMLElement: typeof HTMLElement }).HTMLElement,
    Element: (parsed.window as { Element: typeof Element }).Element,
    Node: (parsed.window as { Node: typeof Node }).Node,
    Event: (parsed.window as { Event: typeof Event }).Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = parsed.document.getElementById('root');
  if (!container) throw new Error('linkedom root missing');
  return {
    container: container as HTMLElement,
    cleanup: () => {
      for (const [name, value] of previous) globals[name] = value;
    },
  };
}

const models = [
  { id: 'alpha', name: 'Alpha', variants: ['high', 'none'] },
  { id: 'beta', name: 'Beta', variants: ['high'] },
  { id: 'gamma', name: 'Gamma', variants: ['none'] },
];

function initialData(variant?: string, activationMode: 'webhook' | 'scheduled' = 'webhook') {
  return {
    triggerId: 'daily-report',
    activationMode,
    cronExpression: activationMode === 'scheduled' ? '0 9 * * *' : undefined,
    githubRepo: 'kilo/cloud',
    mode: 'ask' as const,
    model: 'alpha',
    ...(variant === undefined ? {} : { variant }),
    promptTemplate: 'Run the task',
    profileId: 'profile-1',
  };
}

function submit(container: HTMLElement) {
  const form = container.querySelector('form');
  if (!form) throw new Error('form not found');
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

function click(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll('button')).find(
    item => item.textContent === text
  );
  if (!button) throw new Error(`button not found: ${text}`);
  act(() => button.click());
}

function changeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const reactPropsKey = Object.keys(element).find(key => key.startsWith('__reactProps'));
    const reactProps = reactPropsKey
      ? (
          element as unknown as Record<
            string,
            { onChange?: (event: { target: { value: string } }) => void }
          >
        )[reactPropsKey]
      : undefined;
    if (!reactProps?.onChange) throw new Error('change handler missing');
    reactProps.onChange({ target: { value } });
  });
}

function expectSubmittedVariantToBeOmitted(onSubmit: jest.Mock<TriggerFormProps['onSubmit']>) {
  const [submission] = onSubmit.mock.calls.at(-1) ?? [];
  if (!submission) throw new Error('form submission missing');
  expect(Object.hasOwn(submission, 'variant')).toBe(false);
}

function selectContainerAllocation(
  container: HTMLElement,
  value: 'automatic' | 'isolated-standard'
) {
  click(container, value === 'automatic' ? 'Automatic' : 'Dedicated Standard');
}

function expectSubmittedSandboxAllocationToBeOmitted(
  onSubmit: jest.Mock<TriggerFormProps['onSubmit']>
) {
  const [submission] = onSubmit.mock.calls.at(-1) ?? [];
  if (!submission) throw new Error('form submission missing');
  expect(Object.hasOwn(submission, 'sandboxAllocation')).toBe(false);
}

let TriggerForm!: typeof TriggerFormComponent;

beforeAll(async () => {
  ({ TriggerForm } = await import('./TriggerForm'));
});

describe('TriggerForm variants', () => {
  let root: Root | undefined;
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    cleanup?.();
    cleanup = undefined;
  });

  function render(props: Partial<TriggerFormProps>) {
    const dom = installDom();
    cleanup = dom.cleanup;
    root = createRoot(dom.container);
    const onSubmit = jest.fn<TriggerFormProps['onSubmit']>();
    onSubmit.mockResolvedValue(undefined);
    const allProps: TriggerFormProps = {
      mode: 'edit',
      initialData: initialData('high'),
      repositories: [],
      models,
      onSubmit,
      ...props,
    };
    act(() => root?.render(createElement(TriggerForm, allProps)));
    return { container: dom.container, onSubmit, allProps };
  }

  it.each(['webhook', 'scheduled'] as const)(
    'omits unset legacy %s edit variants, including after catalogue metadata arrives',
    async activationMode => {
      const mounted = render({ initialData: initialData(undefined, activationMode), models: [] });

      act(() => root?.render(createElement(TriggerForm, { ...mounted.allProps, models })));
      submit(mounted.container);
      await act(async () => Promise.resolve());
      expectSubmittedVariantToBeOmitted(mounted.onSubmit);
    }
  );

  it('omits unchanged configured effort, sends selected effort, and clears existing effort to null', async () => {
    const mounted = render({ initialData: initialData('high') });

    submit(mounted.container);
    await act(async () => Promise.resolve());
    expectSubmittedVariantToBeOmitted(mounted.onSubmit);

    click(mounted.container, 'none');
    submit(mounted.container);
    await act(async () => Promise.resolve());
    expect(mounted.onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ variant: 'none' }));

    click(mounted.container, 'default');
    submit(mounted.container);
    await act(async () => Promise.resolve());
    expect(mounted.onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ variant: null }));
  });

  it.each(['webhook', 'scheduled'] as const)(
    'keeps unset %s create variants omitted and preserves explicit none effort',
    async activationMode => {
      const mounted = render({
        mode: 'create',
        initialData: initialData(undefined, activationMode),
      });

      submit(mounted.container);
      await act(async () => Promise.resolve());
      expectSubmittedVariantToBeOmitted(mounted.onSubmit);

      click(mounted.container, 'none');
      submit(mounted.container);
      await act(async () => Promise.resolve());
      expect(mounted.onSubmit).toHaveBeenLastCalledWith(
        expect.objectContaining({ activationMode, variant: 'none' })
      );
    }
  );

  it('preserves compatible effort, resets incompatible effort, and ignores catalogue refreshes', async () => {
    const mounted = render({});
    expect(mounted.container.querySelector('[data-variant]')?.getAttribute('data-variant')).toBe(
      'high'
    );

    click(mounted.container, 'beta');
    expect(mounted.container.querySelector('[data-variant]')?.getAttribute('data-variant')).toBe(
      'high'
    );

    click(mounted.container, 'beta');
    expect(mounted.container.querySelector('[data-variant]')?.getAttribute('data-variant')).toBe(
      'high'
    );

    act(() => root?.render(createElement(TriggerForm, mounted.allProps)));
    click(mounted.container, 'alpha');
    submit(mounted.container);
    await act(async () => Promise.resolve());
    expectSubmittedVariantToBeOmitted(mounted.onSubmit);

    act(() => root?.render(createElement(TriggerForm, { ...mounted.allProps, models: [] })));
    expect(mounted.container.querySelector('[data-variant]')?.getAttribute('data-variant')).toBe(
      'high'
    );

    act(() => root?.render(createElement(TriggerForm, mounted.allProps)));
    click(mounted.container, 'gamma');
    expect(mounted.container.querySelector('[data-variant]')?.getAttribute('data-variant')).toBe(
      'unset'
    );
    submit(mounted.container);
    await act(async () => Promise.resolve());
    expect(mounted.onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ variant: null }));
  });

  it('resets the effort from changed edit initial data and disables effort controls while loading', () => {
    const mounted = render({});
    act(() =>
      root?.render(
        createElement(TriggerForm, { ...mounted.allProps, initialData: initialData('none') })
      )
    );
    expect(mounted.container.querySelector('[data-variant]')?.getAttribute('data-variant')).toBe(
      'none'
    );

    act(() => root?.render(createElement(TriggerForm, { ...mounted.allProps, isLoading: true })));
    expect(mounted.container.querySelector('[data-variant]')?.getAttribute('data-disabled')).toBe(
      'true'
    );
    expect(
      Array.from(mounted.container.querySelectorAll('button')).find(
        item => item.textContent === 'high'
      )
    ).toHaveProperty('disabled', true);
  });
});

describe('TriggerForm container allocation', () => {
  let root: Root | undefined;
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    cleanup?.();
    cleanup = undefined;
  });

  function render(props: Partial<TriggerFormProps>) {
    const dom = installDom();
    cleanup = dom.cleanup;
    root = createRoot(dom.container);
    const onSubmit = jest.fn<TriggerFormProps['onSubmit']>();
    onSubmit.mockResolvedValue(undefined);
    const allProps: TriggerFormProps = {
      mode: 'edit',
      initialData: initialData(),
      repositories: [],
      models,
      onSubmit,
      canSetSandboxAllocation: true,
      ...props,
    };
    act(() => root?.render(createElement(TriggerForm, allProps)));
    return { container: dom.container, onSubmit, allProps };
  }

  it('omits Automatic and submits Dedicated Standard in create mode', async () => {
    const mounted = render({ mode: 'create', initialData: initialData() });
    submit(mounted.container);
    await act(async () => Promise.resolve());
    expectSubmittedSandboxAllocationToBeOmitted(mounted.onSubmit);

    selectContainerAllocation(mounted.container, 'isolated-standard');
    submit(mounted.container);
    await act(async () => Promise.resolve());
    expect(mounted.onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ sandboxAllocation: 'isolated-standard' })
    );
  });

  it('omits unchanged edit allocation and supports set, clear, and restoring the saved value', async () => {
    const unset = render({ initialData: initialData() });
    submit(unset.container);
    await act(async () => Promise.resolve());
    expectSubmittedSandboxAllocationToBeOmitted(unset.onSubmit);

    selectContainerAllocation(unset.container, 'isolated-standard');
    submit(unset.container);
    await act(async () => Promise.resolve());
    expect(unset.onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ sandboxAllocation: 'isolated-standard' })
    );

    act(() => root?.unmount());
    const saved = { ...initialData(), sandboxAllocation: 'isolated-standard' as const };
    const mounted = render({ initialData: saved });
    submit(mounted.container);
    await act(async () => Promise.resolve());
    expectSubmittedSandboxAllocationToBeOmitted(mounted.onSubmit);

    selectContainerAllocation(mounted.container, 'automatic');
    submit(mounted.container);
    await act(async () => Promise.resolve());
    expect(mounted.onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ sandboxAllocation: null })
    );

    selectContainerAllocation(mounted.container, 'isolated-standard');
    submit(mounted.container);
    await act(async () => Promise.resolve());
    expectSubmittedSandboxAllocationToBeOmitted(mounted.onSubmit);
  });

  it('hides fresh allocation from ineligible users but preserves a saved allocation and clearing it', async () => {
    const fresh = render({ canSetSandboxAllocation: false });
    expect(fresh.container.querySelector('[data-container-allocation]')).toBeNull();

    act(() => root?.unmount());
    const saved = render({
      canSetSandboxAllocation: false,
      initialData: { ...initialData(), sandboxAllocation: 'isolated-standard' },
    });
    expect(saved.container.querySelector('[data-container-allocation]')).not.toBeNull();
    selectContainerAllocation(saved.container, 'automatic');
    submit(saved.container);
    await act(async () => Promise.resolve());
    expect(saved.onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ sandboxAllocation: null })
    );
  });

  it('blocks a pending allocation selection after eligibility is revoked until Automatic is restored', async () => {
    const mounted = render({ mode: 'create' });
    selectContainerAllocation(mounted.container, 'isolated-standard');
    act(() =>
      root?.render(
        createElement(TriggerForm, { ...mounted.allProps, canSetSandboxAllocation: false })
      )
    );
    submit(mounted.container);
    expect(mounted.onSubmit).not.toHaveBeenCalled();

    expect(mounted.container.querySelector('[data-container-allocation]')).not.toBeNull();
    selectContainerAllocation(mounted.container, 'automatic');
    submit(mounted.container);
    await act(async () => Promise.resolve());
    expectSubmittedSandboxAllocationToBeOmitted(mounted.onSubmit);
  });

  it('blocks a new Dedicated Standard selection while capabilities are loading', () => {
    const mounted = render({ mode: 'create', isLoadingCapabilities: true });
    act(() =>
      root?.render(
        createElement(TriggerForm, { ...mounted.allProps, isLoadingCapabilities: false })
      )
    );
    selectContainerAllocation(mounted.container, 'isolated-standard');
    act(() =>
      root?.render(createElement(TriggerForm, { ...mounted.allProps, isLoadingCapabilities: true }))
    );
    submit(mounted.container);
    expect(mounted.onSubmit).not.toHaveBeenCalled();
  });

  it('resets from refreshed initial data and disables while capabilities load', () => {
    const mounted = render({});
    selectContainerAllocation(mounted.container, 'isolated-standard');
    act(() =>
      root?.render(
        createElement(TriggerForm, {
          ...mounted.allProps,
          initialData: { ...initialData(), sandboxAllocation: null },
          isLoadingCapabilities: true,
        })
      )
    );
    const select = mounted.container.querySelector('[data-container-allocation]');
    expect(select?.getAttribute('data-container-allocation')).toBe('automatic');
    expect(select?.getAttribute('data-disabled')).toBe('true');
  });
});

describe('TriggerForm save and invoke', () => {
  let root: Root | undefined;
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    cleanup?.();
    cleanup = undefined;
  });

  function render(props: Partial<TriggerFormProps>) {
    const dom = installDom();
    cleanup = dom.cleanup;
    root = createRoot(dom.container);
    const onSubmit = jest.fn<TriggerFormProps['onSubmit']>().mockResolvedValue(undefined);
    const onSaveAndInvoke = jest.fn<NonNullable<TriggerFormProps['onSaveAndInvoke']>>();
    onSaveAndInvoke.mockResolvedValue(undefined);
    act(() =>
      root?.render(
        createElement(TriggerForm, {
          mode: 'edit',
          initialData: initialData('high', 'scheduled'),
          repositories: [],
          models,
          onSubmit,
          onSaveAndInvoke,
          canSetSandboxAllocation: true,
          ...props,
        })
      )
    );
    return { container: dom.container, onSaveAndInvoke };
  }

  it('uses current validated scheduled form data with the same omission mapping', async () => {
    const mounted = render({});
    const prompt = mounted.container.querySelector('#promptTemplate');
    if (prompt?.tagName !== 'TEXTAREA') {
      throw new Error('prompt field missing');
    }
    changeValue(prompt as HTMLTextAreaElement, 'Use the current prompt');
    click(mounted.container, 'none');
    selectContainerAllocation(mounted.container, 'isolated-standard');
    click(mounted.container, 'Save and invoke now');
    await act(async () => Promise.resolve());

    expect(mounted.onSaveAndInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTemplate: 'Use the current prompt',
        variant: 'none',
        sandboxAllocation: 'isolated-standard',
      })
    );
  });

  it('only exposes the action for active scheduled edits and blocks duplicate clicks', async () => {
    let resolveSaveAndInvoke: () => void = () => undefined;
    const pending = new Promise<void>(resolve => {
      resolveSaveAndInvoke = resolve;
    });
    const onSaveAndInvoke = jest.fn<NonNullable<TriggerFormProps['onSaveAndInvoke']>>();
    onSaveAndInvoke.mockReturnValue(pending);
    const mounted = render({ onSaveAndInvoke, initialData: initialData('high', 'scheduled') });
    const saveAndInvokeButton = Array.from(mounted.container.querySelectorAll('button')).find(
      button => button.textContent === 'Save and invoke now'
    );
    if (!saveAndInvokeButton) throw new Error('save and invoke button missing');
    act(() => {
      saveAndInvokeButton.click();
      saveAndInvokeButton.click();
    });
    expect(onSaveAndInvoke).toHaveBeenCalledTimes(1);
    await act(async () => resolveSaveAndInvoke());

    act(() => root?.unmount());
    const paused = render({
      initialData: { ...initialData('high', 'scheduled'), isActive: false },
    });
    const pausedButton = Array.from(paused.container.querySelectorAll('button')).find(
      button => button.textContent === 'Save and invoke now'
    );
    expect(pausedButton).toHaveProperty('disabled', true);

    act(() => root?.unmount());
    const webhook = render({ initialData: initialData('high', 'webhook') });
    expect(webhook.container.textContent).not.toContain('Save and invoke now');

    act(() => root?.unmount());
    const create = render({ mode: 'create', initialData: initialData('high', 'scheduled') });
    expect(create.container.textContent).not.toContain('Save and invoke now');
  });
});
