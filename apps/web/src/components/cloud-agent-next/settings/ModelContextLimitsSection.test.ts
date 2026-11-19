import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import * as React from 'react';
import type { Root } from 'react-dom/client';
import type { ModelOption } from '@/components/shared/ModelCombobox';
import type { CloudAgentSettingsData } from '@/hooks/useCloudAgentSettings';

const MODEL = 'example/model';
const LARGE_MODEL = 'example/large';
const SMALL_MODEL = 'example/small';

const mockMutate =
  jest.fn<
    (
      input: { limits: Record<string, number> },
      options: { onError: (error: Error) => void }
    ) => void
  >();
const mockToastError = jest.fn();

jest.mock('@/hooks/useCloudAgentSettings', () => ({
  useSetModelContextLimitsMutation: () => ({ isPending: false, mutate: mockMutate }),
}));

jest.mock('@/lib/hooks/use-openrouter-models', () => ({
  useModelSelectorList: () => ({
    data: {
      data: [
        { id: MODEL, name: 'Example', context_length: 32_000 },
        { id: LARGE_MODEL, name: 'Large', context_length: 12_000_000 },
        { id: SMALL_MODEL, name: 'Small', context_length: 512 },
      ],
    },
    isLoading: false,
  }),
}));

jest.mock('@/components/shared/ModelCombobox', () => ({
  ModelCombobox: ({
    models,
    onValueChange,
    triggerAriaLabel,
  }: {
    models: ModelOption[];
    onValueChange: (id: string) => void;
    triggerAriaLabel: string;
  }) =>
    React.createElement(
      'div',
      { role: 'group', 'aria-label': triggerAriaLabel },
      models.map(({ id }) =>
        React.createElement(
          'button',
          { key: id, 'aria-label': `Add ${id}`, onClick: () => onValueChange(id) },
          id
        )
      )
    ),
}));

jest.mock('sonner', () => ({ toast: { error: mockToastError } }));

const requireFromHere = createRequire(__filename);
const { parseHTML } = requireFromHere('linkedom') as {
  parseHTML: (html: string) => { window: typeof globalThis; document: Document };
};

describe('ModelContextLimitsSection', () => {
  let root: Root;
  let container: HTMLElement;
  let restoreGlobals: () => void;

  beforeEach(async () => {
    jest.clearAllMocks();
    const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
    document.oninput = null;
    const globals = {
      React,
      window,
      document,
      HTMLElement: window.HTMLElement,
      HTMLInputElement: window.HTMLInputElement,
      Event: window.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.fromEntries(
      Object.keys(globals).map(key => [key, Reflect.get(globalThis, key)])
    );
    Object.assign(globalThis, globals);
    restoreGlobals = () => void Object.assign(globalThis, previous);
    const { createRoot } = await import('react-dom/client');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    React.act(() => root.unmount());
    restoreGlobals();
  });

  async function render(limits: Record<string, number> = {}) {
    const { ModelContextLimitsSection } = await import('./ModelContextLimitsSection');
    const settings: CloudAgentSettingsData = {
      canManage: true,
      contextAllocation: null,
      builtinAgents: {},
      modelContextLimits: limits,
      repositories: [],
      capabilities: null,
      capabilitiesByPlatform: { github: null, gitlab: null },
    };
    React.act(() => root.render(React.createElement(ModelContextLimitsSection, { settings })));
  }

  function input(): HTMLInputElement {
    const field = container.querySelector('input');
    if (!field) throw new Error('Model context limit input missing');
    return field;
  }

  function edit(value: string) {
    const field = input();
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setValue) throw new Error('Input value setter missing');
    React.act(() => {
      setValue.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    React.act(() => {
      field.dispatchEvent(new Event('focusout', { bubbles: true }));
    });
  }

  function click(selector: string) {
    const button = container.querySelector(selector);
    if (!button) throw new Error(`Control not found: ${selector}`);
    React.act(() => {
      button.dispatchEvent(new Event('click', { bubbles: true }));
    });
  }

  it.each([
    [MODEL, 32_000],
    [LARGE_MODEL, 10_000_000],
  ])(
    'adds %s at the smaller of its context window and the global maximum',
    async (model, limit) => {
      await render();
      const picker = container.querySelector('[aria-label="Add a model context limit"]');
      expect(picker?.textContent).not.toContain(SMALL_MODEL);
      click(`[aria-label="Add ${model}"]`);
      expect(mockMutate).toHaveBeenCalledWith({ limits: { [model]: limit } }, expect.anything());
    }
  );

  it('keeps an invalid draft, describes the allowed range, and saves only the corrected value', async () => {
    await render({ [MODEL]: 30_000 });
    const field = input();
    const hintId = field.getAttribute('aria-describedby');
    expect(field.getAttribute('max')).toBe('32000');
    expect(hintId).toBeTruthy();
    expect(document.getElementById(hintId ?? '')?.textContent).toBe('1,000–32,000 tokens');

    edit('32001');
    expect(field.value).toBe('32001');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(hintId ?? '')?.textContent).toContain('Enter a whole number');
    expect(mockMutate).not.toHaveBeenCalled();

    edit('31999');
    expect(field.getAttribute('aria-invalid')).toBe('false');
    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(mockMutate).toHaveBeenCalledWith({ limits: { [MODEL]: 31_999 } }, expect.anything());
  });

  it('uses the global upper bound for a model no longer in the catalog', async () => {
    await render({ 'example/retired': 30_000 });
    expect(input().getAttribute('max')).toBe('10000000');
  });

  it('removes only the selected cap', async () => {
    await render({ [MODEL]: 30_000, [LARGE_MODEL]: 100_000 });
    click(`[aria-label="Remove context limit for ${MODEL}"]`);
    expect(mockMutate).toHaveBeenCalledWith(
      { limits: { [LARGE_MODEL]: 100_000 } },
      expect.anything()
    );
    expect(container.querySelector(`[aria-label="Context limit for ${MODEL}"]`)).toBeNull();
  });

  it('hides the picker when all 50 slots are in use', async () => {
    await render(
      Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`example/model-${i}`, 1000]))
    );
    expect(container.querySelectorAll('input')).toHaveLength(50);
    expect(container.querySelector('[aria-label="Add a model context limit"]')).toBeNull();
  });

  it('restores the saved limit and reports a rejected mutation', async () => {
    await render({ [MODEL]: 30_000 });
    edit('20000');
    expect(input().value).toBe('20000');
    const call = mockMutate.mock.calls[0];
    if (!call) throw new Error('No save attempted');

    React.act(() => call[1].onError(new Error('Unable to save the limit')));
    expect(input().value).toBe('30000');
    expect(mockToastError).toHaveBeenCalledWith('Unable to save the limit');
  });
});
