import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import {
  createEmptyEnkryptOutputDetectors,
  createKiloDefaultEnkryptInputDetectors,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import type { EnkryptGuardrailsConfig } from './enkrypt-guardrails-draft';
import type { OrganizationGuardrailsPage as PageComponent } from './OrganizationGuardrailsPage';

type GuardrailsResponse = EnkryptGuardrailsConfig & {
  output_available: boolean;
  invalid_saved_detectors: boolean;
  invalid_saved_output_detectors: boolean;
};
type GuardrailsUpdate = Omit<EnkryptGuardrailsConfig, 'output'> & {
  organizationId: string;
  output?: EnkryptGuardrailsConfig['output'];
};

const organizationId = 'aaaaaaaa-1111-4111-8111-111111111111';
const queryKey = ['organization-guardrails', organizationId];
let mockConfig: GuardrailsResponse;
const mockUpdate = jest.fn<(input: GuardrailsUpdate) => Promise<GuardrailsResponse>>();

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    organizations: {
      guardrails: {
        get: {
          queryOptions: () => ({
            queryKey,
            queryFn: () => Promise.resolve(mockConfig),
            initialData: mockConfig,
            staleTime: Infinity,
          }),
          queryKey: () => queryKey,
        },
        update: {
          mutationOptions: (
            options: UseMutationOptions<GuardrailsResponse, Error, GuardrailsUpdate>
          ) => ({ ...options, mutationFn: (input: GuardrailsUpdate) => mockUpdate(input) }),
        },
      },
    },
  }),
}));
jest.mock('@/contexts/RoleTestingContext', () => ({
  useRoleTesting: () => ({ assumedRole: null }),
}));
jest.mock('../OrganizationPageHeader', () => ({ OrganizationPageHeader: () => null }));
jest.mock('./mcp-and-skills/McpSkillGuardrailsSection', () => ({
  McpSkillGuardrailsSection: () => createElement('div', null, 'MCP and skill guardrails'),
}));

describe('OrganizationGuardrailsPage output availability', () => {
  let container: HTMLElement;
  let root: Root;
  let cleanup: () => void;
  let queryClient: QueryClient;
  let Page: typeof PageComponent;

  beforeEach(async () => {
    jest.useFakeTimers();
    mockConfig = {
      enabled: true,
      detectors: createKiloDefaultEnkryptInputDetectors(),
      output: { enabled: false, detectors: createEmptyEnkryptOutputDetectors() },
      output_available: false,
      invalid_saved_detectors: false,
      invalid_saved_output_detectors: false,
    };
    mockUpdate.mockReset().mockImplementation(async input => {
      mockConfig = {
        ...mockConfig,
        enabled: input.enabled,
        detectors: input.detectors,
        invalid_saved_detectors: false,
        ...(input.output ? { output: input.output, invalid_saved_output_detectors: false } : {}),
      };
      return mockConfig;
    });
    const { parseHTML } = createRequire(__filename)('linkedom') as {
      parseHTML: (html: string) => { window: typeof globalThis; document: Document };
    };
    const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
    document.oninput = null;
    const checkedDescriptor = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'checked'
    );
    Object.defineProperty(window.HTMLInputElement.prototype, 'checked', {
      configurable: true,
      get(this: HTMLInputElement) {
        return this.hasAttribute('checked');
      },
      set(this: HTMLInputElement, checked: boolean) {
        this.toggleAttribute('checked', checked);
      },
    });
    const globals = {
      React,
      window,
      document,
      HTMLElement: window.HTMLElement,
      HTMLInputElement: window.HTMLInputElement,
      HTMLTextAreaElement: window.HTMLTextAreaElement,
      Element: window.Element,
      Node: window.Node,
      Event: window.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = new Map(
      Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
    );
    Object.assign(globalThis, globals);
    cleanup = () => {
      if (checkedDescriptor) {
        Object.defineProperty(window.HTMLInputElement.prototype, 'checked', checkedDescriptor);
      } else {
        Reflect.deleteProperty(window.HTMLInputElement.prototype, 'checked');
      }
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    };
    const element = document.getElementById('root');
    if (!element) throw new Error('Test root missing');
    container = element;
    const { createRoot } = await import('react-dom/client');
    ({ OrganizationGuardrailsPage: Page } = await import('./OrganizationGuardrailsPage'));
    queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    queryClient?.clear();
    cleanup?.();
    jest.useRealTimers();
  });

  function render() {
    act(() =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Page, { organizationId, role: 'owner' })
        )
      )
    );
  }

  function switchControl(label: string) {
    const found = labelledBy<HTMLButtonElement>('[role="switch"]', label);
    if (!found) throw new Error(`Switch missing: ${label}`);
    return found;
  }

  function labelledBy<T extends Element>(selector: string, label: string) {
    return Array.from(container.querySelectorAll<T>(selector)).find(candidate => {
      const labelId = candidate.getAttribute('aria-labelledby');
      return labelId && document.getElementById(labelId)?.textContent === label;
    });
  }

  function choiceGroup(label: string) {
    const found = labelledBy('[role="radiogroup"]', label);
    if (!found) throw new Error(`Choice missing: ${label}`);
    return found;
  }

  function choiceInputs(label: string) {
    return Array.from(choiceGroup(label).querySelectorAll<HTMLInputElement>('input[type="radio"]'));
  }

  function checkedChoice(label: string) {
    return choiceInputs(label).find(input => input.checked)?.parentElement?.textContent;
  }

  function choose(label: string, choice: 'Off' | 'Log only' | 'Block') {
    const input = choiceInputs(label).find(
      candidate => candidate.parentElement?.textContent === choice
    );
    if (!input) throw new Error(`Choice missing: ${label} ${choice}`);
    act(() => {
      input.setAttribute('checked', '');
      input.dispatchEvent(new Event('click', { bubbles: true }));
    });
  }

  function textElement(text: string) {
    const found = Array.from(container.querySelectorAll('*')).find(
      candidate => candidate.children.length === 0 && candidate.textContent === text
    );
    if (!found) throw new Error(`Text missing: ${text}`);
    return found;
  }

  function button(label: string) {
    const found = Array.from(container.querySelectorAll('button')).find(
      candidate => candidate.textContent === label
    );
    if (!found) throw new Error(`Button missing: ${label}`);
    return found;
  }

  async function advance(ms = 800) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
  }

  it('hides output controls but keeps saved-output errors and a recovery path visible', () => {
    mockConfig.output.enabled = true;
    mockConfig.invalid_saved_output_detectors = true;
    render();

    expect(container.textContent).not.toContain('Output guardrails');
    expect(container.textContent).toContain("Saved output detector settings can't be read");
    expect(container.textContent).toContain('Responses are withheld');
    expect(container.textContent).toContain(
      'Contact Kilo support to restore access to output detector settings.'
    );
    expect(container.textContent).not.toContain('Save detector settings');
    expect(container.querySelectorAll('[role="radiogroup"]')).toHaveLength(2);
    expect(switchControl('Input guardrails').getAttribute('aria-checked')).toBe('true');
    expect(checkedChoice('Prompt injection')).toBe('Block');
    expect(checkedChoice('Policy violation')).toBe('Off');
    expect(container.textContent).toContain('MCP and skill guardrails');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('shows input and output guardrails as sections of one Enkrypt AI guardrails card', () => {
    mockConfig.output_available = true;
    render();

    const card = textElement('Enkrypt AI guardrails').closest('.bg-card');
    const sections = Array.from(card?.querySelectorAll('section > div > div > h3') ?? []);
    expect(sections.map(heading => heading.textContent)).toEqual([
      'Input guardrails',
      'Output guardrails',
    ]);
    expect(container.querySelectorAll('.bg-card')).toHaveLength(1);
    expect(switchControl('Output guardrails').getAttribute('aria-checked')).toBe('false');
  });

  it('saves Log only and Off choices for input detectors', async () => {
    render();

    choose('Prompt injection', 'Log only');
    expect(checkedChoice('Prompt injection')).toBe('Log only');
    await advance();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][0].detectors.injection_attack).toEqual({
      enabled: true,
      action: 'log',
    });
    expect(container.textContent).toContain('All changes saved.');

    choose('Prompt injection', 'Off');
    await advance();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Not saved yet. Turn on at least one input detector.');

    choose('Prompt injection', 'Block');
    await advance();
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(mockUpdate.mock.calls[1][0].detectors.injection_attack).toEqual({
      enabled: true,
      action: 'block',
    });
  });

  it('shows and saves output controls and warnings when available, independently of input guardrails', async () => {
    mockConfig.enabled = false;
    mockConfig.output_available = true;
    mockConfig.output.enabled = true;
    mockConfig.output.detectors.toxicity.enabled = true;
    mockConfig.invalid_saved_output_detectors = true;
    render();

    expect(container.textContent).toContain('Output guardrails');
    expect(container.textContent).toContain("Saved output detector settings can't be read");
    expect(labelledBy('[role="radiogroup"]', 'Prompt injection')).toBeUndefined();
    expect(checkedChoice('Toxicity')).toBe('Block');

    act(() => switchControl('Output guardrails').click());
    await advance();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenLastCalledWith({
      organizationId,
      enabled: false,
      detectors: mockConfig.detectors,
      output: { ...mockConfig.output, enabled: false },
    });
    expect(container.textContent).toContain('All changes saved.');
    await advance();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it.each(['valid', 'no enabled detector', 'invalid topic', 'legacy action'])(
    'omits hidden output from debounced input autosaves with %s output settings',
    async outputCase => {
      mockConfig.output.enabled = true;
      if (outputCase === 'valid') mockConfig.output.detectors.toxicity.enabled = true;
      if (outputCase === 'invalid topic') {
        mockConfig.output.detectors.topic_detector.enabled = true;
      }
      if (outputCase === 'legacy action') {
        Object.assign(mockConfig.output.detectors.toxicity, {
          enabled: true,
          action: 'revise',
        });
      }
      mockConfig.invalid_saved_output_detectors = outputCase !== 'valid';
      const savedOutput = structuredClone(mockConfig.output);
      render();

      act(() => switchControl('Input guardrails').click());
      await advance(799);
      expect(mockUpdate).not.toHaveBeenCalled();
      await advance(1);

      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(mockUpdate).toHaveBeenLastCalledWith({
        organizationId,
        enabled: false,
        detectors: mockConfig.detectors,
      });
      expect(mockUpdate.mock.calls[0][0]).not.toHaveProperty('output');
      expect(mockConfig.output).toEqual(savedOutput);
      expect(container.textContent).toContain('All changes saved.');
      expect(container.textContent).not.toContain('Not saved yet.');
      await advance();
      expect(mockUpdate).toHaveBeenCalledTimes(1);
    }
  );

  it.each([false, true])(
    'stops saving hidden response edits after availability is revoked with input dirty: %s',
    async editInput => {
      mockConfig.output_available = true;
      mockConfig.output.detectors.toxicity.enabled = true;
      const savedOutput = structuredClone(mockConfig.output);
      render();

      act(() => {
        switchControl('Output guardrails').click();
        if (editInput) switchControl('Input guardrails').click();
      });
      await advance(400);
      expect(mockUpdate).not.toHaveBeenCalled();

      mockConfig = { ...mockConfig, output_available: false };
      act(() => {
        queryClient.setQueryData(queryKey, mockConfig);
      });
      await advance(400);
      expect(container.textContent).not.toContain('Output guardrails');
      expect(mockUpdate).toHaveBeenCalledTimes(editInput ? 1 : 0);
      if (editInput) {
        expect(mockUpdate).toHaveBeenLastCalledWith({
          organizationId,
          enabled: false,
          detectors: mockConfig.detectors,
        });
      }
      expect(mockConfig.output).toEqual(savedOutput);
      expect(container.textContent).not.toContain('Saving');

      for (let cycle = 0; cycle < 3; cycle++) await advance();
      expect(mockUpdate).toHaveBeenCalledTimes(editInput ? 1 : 0);
    }
  );

  it('saves dirty input once when hidden output changes remotely', async () => {
    render();
    act(() => switchControl('Input guardrails').click());
    await advance(400);

    const remoteOutput = {
      enabled: true,
      detectors: {
        ...mockConfig.output.detectors,
        toxicity: { enabled: true, action: 'log' as const },
      },
    };
    mockConfig = { ...mockConfig, output: remoteOutput };
    act(() => {
      queryClient.setQueryData(queryKey, mockConfig);
    });
    await advance(400);

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenLastCalledWith({
      organizationId,
      enabled: false,
      detectors: mockConfig.detectors,
    });
    expect(mockConfig.output).toEqual(remoteOutput);
    expect(container.textContent).toContain('All changes saved.');
    for (let cycle = 0; cycle < 3; cycle++) await advance();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('omits hidden invalid output from input repair saves', async () => {
    mockConfig.invalid_saved_detectors = true;
    mockConfig.invalid_saved_output_detectors = true;
    mockConfig.output.enabled = true;
    render();

    expect(button('Save detector settings').disabled).toBe(false);
    await act(async () => button('Save detector settings').click());
    await advance(0);

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenLastCalledWith({
      organizationId,
      enabled: true,
      detectors: mockConfig.detectors,
    });
    expect(container.textContent).not.toContain("Saved input detector settings can't be read");
  });

  it('keeps failed autosaves paused and omits hidden invalid output on manual retry', async () => {
    mockConfig.output.enabled = true;
    mockUpdate.mockRejectedValueOnce(new Error('Save unavailable'));
    render();
    act(() => switchControl('Input guardrails').click());
    await advance();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Save unavailable');
    await advance();
    expect(mockUpdate).toHaveBeenCalledTimes(1);

    await act(async () => button('Try again').click());
    await advance(0);
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(mockUpdate.mock.calls.every(([input]) => !('output' in input))).toBe(true);
    expect(container.textContent).toContain('All changes saved.');
  });
});
