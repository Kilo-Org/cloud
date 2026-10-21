import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  getSandboxAllocationRequest,
  type SandboxAllocation,
  type SandboxSelectionCapabilities,
} from '@kilocode/worker-utils/sandbox-allocation';
import type { TriggerForm as TriggerFormComponent, TriggerFormProps } from './TriggerForm';

jest.mock('sonner', () => ({ toast: { error: jest.fn(), success: jest.fn() } }));
jest.mock('next-auth/react', () => ({
  useSession: () => ({
    data: {
      user: { id: 'oauth/github/creator', name: 'test-creator', email: 'creator@example.com' },
    },
  }),
}));
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
jest.mock('@/components/ui/checkbox', () => ({
  Checkbox: ({
    onCheckedChange,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & {
    onCheckedChange?: (checked: boolean) => void;
  }) =>
    createElement('input', {
      ...props,
      type: 'checkbox',
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        onCheckedChange?.(event.target.checked),
    }),
}));
type SelectInjectedProps = {
  onValueChange?: (value: string) => void;
  selectDisabled?: boolean;
};

function withSelectProps(children: React.ReactNode, props: SelectInjectedProps): React.ReactNode {
  return React.Children.map(children, child =>
    React.isValidElement<SelectInjectedProps & { children?: React.ReactNode }>(child)
      ? React.cloneElement(child, props)
      : child
  );
}

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
      withSelectProps(children, { onValueChange, selectDisabled: disabled })
    ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) =>
    createElement(React.Fragment, {}, children),
  SelectValue: () => null,
  SelectContent: ({ children, ...props }: { children: React.ReactNode } & SelectInjectedProps) =>
    createElement(React.Fragment, {}, withSelectProps(children, props)),
  SelectGroup: ({ children, ...props }: { children: React.ReactNode } & SelectInjectedProps) =>
    createElement(React.Fragment, {}, withSelectProps(children, props)),
  SelectLabel: ({ children }: { children: React.ReactNode }) =>
    createElement('div', { 'data-select-group-label': true }, children),
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
        'data-select-item': value,
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
jest.mock('@/components/cloud-agent/RepoProfileBindingsDialog', () => ({
  RepoProfileBindingsDialog: () => null,
}));
jest.mock('@/components/shared/RepositoryCombobox', () => ({
  RepositoryCombobox: ({
    onValueChange,
    disabled,
  }: {
    onValueChange: (value: string) => void;
    disabled?: boolean;
  }) =>
    createElement(
      'button',
      { type: 'button', disabled, onClick: () => onValueChange('kilo/other') },
      'select-repository'
    ),
}));
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

function sandboxCapabilities(
  overrides: Partial<SandboxSelectionCapabilities> = {}
): SandboxSelectionCapabilities {
  return {
    enabled: true,
    defaultDestination: getSandboxAllocationRequest('cloudflare-containers-standard-3'),
    effectiveDestination: getSandboxAllocationRequest('cloudflare-containers-standard-3'),
    options: [
      { allocation: getSandboxAllocationRequest('cloudflare-containers-standard-3') },
      { allocation: getSandboxAllocationRequest('cloudflare-containers-standard-4') },
      { allocation: getSandboxAllocationRequest('vercel-small') },
      { allocation: getSandboxAllocationRequest('vercel-large') },
    ],
    ...overrides,
  };
}

function selectSandbox(container: HTMLElement, value: SandboxAllocation | 'automatic') {
  const item = container.querySelector<HTMLButtonElement>(`[data-select-item="${value}"]`);
  if (!item) throw new Error(`sandbox option not found: ${value}`);
  act(() => item.click());
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

  it('does not offer creator mode for personal triggers', () => {
    const { container } = render({ mode: 'create' });
    expect(container.textContent).not.toContain('Organization bot');
    expect(container.textContent).not.toContain('test-creator');
  });

  it('requires authentication when selecting creator mode for an organization webhook', () => {
    const { container, onSubmit } = render({ mode: 'create', organizationId: 'org-1' });
    expect(
      container.querySelector('[data-container-allocation="organization-bot"]')
    ).not.toBeNull();
    click(container, 'test-creator');
    expect(container.querySelector('#webhookAuthHeader')).not.toBeNull();
    submit(container);
    expect(onSubmit).not.toHaveBeenCalled();
    const header = container.querySelector<HTMLInputElement>('#webhookAuthHeader');
    const secret = container.querySelector<HTMLInputElement>('#webhookAuthSecret');
    if (!header || !secret) throw new Error('authentication inputs missing');
    changeValue(header, 'x-secret');
    changeValue(secret, 'short-secret');
    submit(container);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.textContent).toContain('at least 16 characters');
    changeValue(secret, 'shared-secret-0123456789');
    submit(container);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        runAsCreator: true,
        webhookAuth: { enabled: true, header: 'x-secret', secret: 'shared-secret-0123456789' },
      })
    );
  });

  it('shows saved creator mode as immutable when editing', () => {
    const { container, onSubmit } = render({
      organizationId: 'org-1',
      initialData: {
        ...initialData('high', 'scheduled'),
        executionUserId: 'oauth/github/creator',
      },
    });
    expect(
      container
        .querySelector('[data-container-allocation="creator"]')
        ?.getAttribute('data-disabled')
    ).toBe('true');
    expect(container.textContent).toContain('test-creator');
    click(container, 'Organization bot');
    submit(container);
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ runAsCreator: true }));
  });

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

describe('TriggerForm sandbox allocation', () => {
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
      sandboxSelection: sandboxCapabilities(),
      ...props,
    };
    act(() => root?.render(createElement(TriggerForm, allProps)));
    return { container: dom.container, onSubmit, allProps };
  }

  it.each(['webhook', 'scheduled'] as const)(
    'omits Automatic and submits a grouped sandbox choice in %s create mode',
    async activationMode => {
      const mounted = render({
        mode: 'create',
        initialData: initialData(undefined, activationMode),
      });
      expect(
        mounted.container
          .querySelector('[data-container-allocation]')
          ?.getAttribute('data-container-allocation')
      ).toBe('automatic');
      submit(mounted.container);
      await act(async () => Promise.resolve());
      expectSubmittedSandboxAllocationToBeOmitted(mounted.onSubmit);

      selectSandbox(mounted.container, 'cloudflare-containers-standard-4');
      expect(
        mounted.container
          .querySelector('[data-container-allocation]')
          ?.getAttribute('data-container-allocation')
      ).toBe('cloudflare-containers-standard-4');
      submit(mounted.container);
      await act(async () => Promise.resolve());
      expect(mounted.onSubmit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          activationMode,
          sandboxAllocation: 'cloudflare-containers-standard-4',
        })
      );

      selectSandbox(mounted.container, 'automatic');
      submit(mounted.container);
      await act(async () => Promise.resolve());
      expectSubmittedSandboxAllocationToBeOmitted(mounted.onSubmit);
    }
  );

  it('omits an unchanged edit allocation and supports set, clear, and restoring the saved value', async () => {
    const saved = {
      ...initialData(),
      sandboxAllocation: 'vercel-large' as const,
    };
    const mounted = render({ initialData: saved });

    submit(mounted.container);
    await act(async () => Promise.resolve());
    expectSubmittedSandboxAllocationToBeOmitted(mounted.onSubmit);

    selectSandbox(mounted.container, 'cloudflare-containers-standard-3');
    submit(mounted.container);
    await act(async () => Promise.resolve());
    expect(mounted.onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ sandboxAllocation: 'cloudflare-containers-standard-3' })
    );

    selectSandbox(mounted.container, 'vercel-large');
    submit(mounted.container);
    await act(async () => Promise.resolve());
    expectSubmittedSandboxAllocationToBeOmitted(mounted.onSubmit);

    selectSandbox(mounted.container, 'automatic');
    submit(mounted.container);
    await act(async () => Promise.resolve());
    expect(mounted.onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ sandboxAllocation: null })
    );
  });

  it('hides fresh allocation from ineligible users but preserves a saved allocation and clearing it', async () => {
    const fresh = render({ canSetSandboxAllocation: false });
    expect(fresh.container.querySelector('[data-container-allocation]')).toBeNull();

    act(() => root?.unmount());
    const saved = render({
      canSetSandboxAllocation: false,
      initialData: { ...initialData(), sandboxAllocation: 'vercel-large' },
    });
    expect(saved.container.querySelector('[data-container-allocation]')).not.toBeNull();
    selectSandbox(saved.container, 'automatic');
    submit(saved.container);
    await act(async () => Promise.resolve());
    expect(saved.onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ sandboxAllocation: null })
    );
  });

  it('blocks a pending selection after eligibility is revoked until Automatic is restored', async () => {
    const mounted = render({ mode: 'create' });
    selectSandbox(mounted.container, 'cloudflare-containers-standard-3');
    act(() =>
      root?.render(
        createElement(TriggerForm, { ...mounted.allProps, canSetSandboxAllocation: false })
      )
    );
    submit(mounted.container);
    expect(mounted.onSubmit).not.toHaveBeenCalled();

    expect(mounted.container.querySelector('[data-container-allocation]')).not.toBeNull();
    selectSandbox(mounted.container, 'automatic');
    submit(mounted.container);
    await act(async () => Promise.resolve());
    expectSubmittedSandboxAllocationToBeOmitted(mounted.onSubmit);
  });

  it('marks a pending selection unavailable when capabilities stop offering it', async () => {
    const mounted = render({ mode: 'create' });
    selectSandbox(mounted.container, 'cloudflare-containers-standard-3');
    act(() =>
      root?.render(
        createElement(TriggerForm, {
          ...mounted.allProps,
          sandboxSelection: sandboxCapabilities({
            options: [
              { allocation: getSandboxAllocationRequest('cloudflare-containers-standard-4') },
            ],
          }),
        })
      )
    );

    const unavailable = mounted.container.querySelector<HTMLButtonElement>(
      '[data-select-item="cloudflare-containers-standard-3"]'
    );
    expect(unavailable).not.toBeNull();
    expect(unavailable).toHaveProperty('disabled', true);
    expect(unavailable?.textContent).toContain('(unavailable)');
    expect(mounted.container.textContent).toContain(
      'Selected sandbox is not available. Choose another sandbox or Automatic.'
    );

    submit(mounted.container);
    expect(mounted.onSubmit).not.toHaveBeenCalled();

    selectSandbox(mounted.container, 'cloudflare-containers-standard-4');
    submit(mounted.container);
    await act(async () => Promise.resolve());
    expect(mounted.onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ sandboxAllocation: 'cloudflare-containers-standard-4' })
    );
  });

  it('blocks a pending selection while capabilities are loading and disables the select', async () => {
    const mounted = render({ mode: 'create' });
    selectSandbox(mounted.container, 'cloudflare-containers-standard-4');
    act(() =>
      root?.render(createElement(TriggerForm, { ...mounted.allProps, isLoadingCapabilities: true }))
    );

    const select = mounted.container.querySelector('[data-container-allocation]');
    expect(select?.getAttribute('data-disabled')).toBe('true');
    const selectedItem = mounted.container.querySelector<HTMLButtonElement>(
      '[data-select-item="cloudflare-containers-standard-4"]'
    );
    expect(selectedItem).toHaveProperty('disabled', true);

    submit(mounted.container);
    expect(mounted.onSubmit).not.toHaveBeenCalled();

    act(() =>
      root?.render(
        createElement(TriggerForm, { ...mounted.allProps, isLoadingCapabilities: false })
      )
    );
    submit(mounted.container);
    await act(async () => Promise.resolve());
    expect(mounted.onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ sandboxAllocation: 'cloudflare-containers-standard-4' })
    );
  });

  it('filters choices unavailable for the provider or repository while keeping eligible groups', async () => {
    const mounted = render({
      mode: 'create',
      sandboxSelection: sandboxCapabilities({
        options: [
          { allocation: getSandboxAllocationRequest('cloudflare-containers-standard-3') },
          {
            allocation: getSandboxAllocationRequest('cloudflare-containers-standard-4'),
            unavailableReason: 'Capacity unavailable',
          },
          {
            allocation: getSandboxAllocationRequest('vercel-small'),
            repositoryUnavailableReason: 'Vercel sandboxes support GitHub repositories only',
          },
          {
            allocation: getSandboxAllocationRequest('vercel-large'),
            unavailableReason: 'Vercel is unavailable',
          },
        ],
      }),
    });

    expect(
      mounted.container.querySelector('[data-select-item="cloudflare-containers-standard-3"]')
    ).not.toBeNull();
    expect(
      mounted.container.querySelector('[data-select-item="cloudflare-containers-standard-4"]')
    ).toBeNull();
    expect(mounted.container.querySelector('[data-select-item="vercel-small"]')).toBeNull();
    expect(mounted.container.querySelector('[data-select-item="vercel-large"]')).toBeNull();
    expect(mounted.container.textContent).toContain('Cloudflare Containers');
    expect(mounted.container.textContent).not.toContain('Vercel');

    selectSandbox(mounted.container, 'cloudflare-containers-standard-3');
    submit(mounted.container);
    await act(async () => Promise.resolve());
    expect(mounted.onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ sandboxAllocation: 'cloudflare-containers-standard-3' })
    );
  });

  it('keeps a saved legacy sandbox displayed, disabled, and unchanged on submit', async () => {
    const mounted = render({
      initialData: { ...initialData(), sandboxAllocation: 'isolated-standard' },
    });

    const legacy = mounted.container.querySelector<HTMLButtonElement>(
      '[data-select-item="isolated-standard"]'
    );
    expect(legacy).not.toBeNull();
    expect(legacy).toHaveProperty('disabled', true);
    expect(legacy?.textContent).toContain('Dedicated Standard (legacy)');
    expect(legacy?.textContent).toContain('(unavailable)');
    expect(
      mounted.container
        .querySelector('[data-container-allocation]')
        ?.getAttribute('data-container-allocation')
    ).toBe('isolated-standard');
    expect(mounted.container.textContent).toContain('The saved sandbox is no longer offered.');

    submit(mounted.container);
    await act(async () => Promise.resolve());
    expectSubmittedSandboxAllocationToBeOmitted(mounted.onSubmit);
  });

  it('never offers legacy in create mode and cannot restore it after clearing an edit', async () => {
    const create = render({ mode: 'create' });
    expect(create.container.querySelector('[data-select-item="isolated-standard"]')).toBeNull();

    act(() => root?.unmount());
    const cleared = render({
      initialData: { ...initialData(), sandboxAllocation: 'isolated-standard' },
    });
    selectSandbox(cleared.container, 'automatic');
    submit(cleared.container);
    await act(async () => Promise.resolve());
    expect(cleared.onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ sandboxAllocation: null })
    );
    expect(cleared.container.querySelector('[data-select-item="isolated-standard"]')).toBeNull();
  });

  it('notifies the parent when a repository is selected in create mode', () => {
    const onRepositoryChange = jest.fn<(repository: string) => void>();
    const mounted = render({ mode: 'create', onRepositoryChange });

    click(mounted.container, 'select-repository');
    expect(onRepositoryChange).toHaveBeenCalledWith('kilo/other');
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
          sandboxSelection: sandboxCapabilities(),
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
    selectSandbox(mounted.container, 'cloudflare-containers-standard-4');
    click(mounted.container, 'Save and invoke now');
    await act(async () => Promise.resolve());

    expect(mounted.onSaveAndInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTemplate: 'Use the current prompt',
        variant: 'none',
        sandboxAllocation: 'cloudflare-containers-standard-4',
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
