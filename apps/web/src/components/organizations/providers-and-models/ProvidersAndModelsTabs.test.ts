import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ModelsTab as ModelsTabComponent } from './ModelsTab';
import type { ProvidersTab as ProvidersTabComponent } from './ProvidersTab';
import type { ModelAccessPolicyEditor as ModelAccessPolicyEditorComponent } from '../groups/policies/model-access/ModelAccessPolicyEditor';
import type { ModelRow, ProviderRow } from './providersAndModels.types';

jest.mock('@/components/organizations/LockableContainer', () => ({
  LockableContainer: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/ui/RadioGroup', () => ({ RadioButtonGroup: () => null }));
jest.mock('@/components/models/CollapsibleFilterSection', () => ({
  CollapsibleFilterSection: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/models/CollapsibleCheckboxFilter', () => ({
  CollapsibleCheckboxFilter: () => null,
}));
jest.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => children,
  SelectContent: ({ children }: { children: React.ReactNode }) => children,
  SelectItem: ({ children }: { children: React.ReactNode }) => children,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => children,
  SelectValue: () => null,
}));
jest.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => children,
  TabsContent: ({ children }: { children: React.ReactNode }) => children,
  TabsList: ({ children }: { children: React.ReactNode }) => children,
  TabsTrigger: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    isLoading: false,
    isError: false,
    data: {
      policyType: 'model_access',
      catalog: {
        providers: [
          {
            slug: 'shown-provider',
            displayName: 'Shown provider',
            dataPolicy: { training: false, retainsPrompts: false },
            models: [{ slug: 'vendor/shown-model', name: 'Shown model', endpoint: {} }],
          },
        ],
      },
    },
  }),
}));
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    organizations: { groups: { getPolicyEditorData: { queryOptions: () => ({}) } } },
  }),
}));

type LinkedomModule = {
  parseHTML: (html: string) => { window: Record<string, unknown>; document: Document };
};

function installDom() {
  const requireFromHere = createRequire(__filename);
  const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));
  const { window, document } = (requireFromNext('linkedom') as LinkedomModule).parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const previous = new Map<string, unknown>();
  for (const name of [
    'React',
    'window',
    'document',
    'HTMLElement',
    'HTMLInputElement',
    'Element',
    'Node',
    'Event',
    'IS_REACT_ACT_ENVIRONMENT',
  ]) {
    previous.set(name, globals[name]);
  }
  Object.assign(globals, {
    React,
    window,
    document,
    HTMLElement: (window as { HTMLElement: typeof HTMLElement }).HTMLElement,
    HTMLInputElement: (window as { HTMLInputElement: typeof HTMLInputElement }).HTMLInputElement,
    Element: (window as { Element: typeof Element }).Element,
    Node: (window as { Node: typeof Node }).Node,
    Event: (window as { Event: typeof Event }).Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.getElementById('root');
  document.oninput = null;
  if (!container) throw new Error('React root missing');
  return {
    container: container as HTMLElement,
    cleanup: () => previous.forEach((value, key) => (globals[key] = value)),
  };
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll('button')).find(
    item => item.textContent?.trim() === text
  );
  if (!result) throw new Error(`Button not found: ${text}`);
  return result;
}

function click(element: HTMLElement) {
  act(() => {
    element.dispatchEvent(new Event('click', { bubbles: true }));
  });
}

const modelRows: ModelRow[] = [
  {
    modelId: 'vendor/enable',
    modelName: 'Enable model',
    providerSlugs: ['one'],
    preferredIndex: undefined,
    sourceIndex: 0,
  },
  {
    modelId: 'vendor/enabled',
    modelName: 'Enabled model',
    providerSlugs: ['one'],
    preferredIndex: undefined,
    sourceIndex: 1,
  },
  {
    modelId: 'vendor/unavailable',
    modelName: 'Unavailable model',
    providerSlugs: ['one'],
    preferredIndex: undefined,
    sourceIndex: 2,
    unavailableReason: 'Unavailable',
  },
  {
    modelId: 'vendor/enabled-unavailable',
    modelName: 'Enabled unavailable model',
    providerSlugs: ['one'],
    preferredIndex: undefined,
    sourceIndex: 3,
    unavailableReason: 'Unavailable',
  },
];

const providerRows: ProviderRow[] = [
  {
    providerSlug: 'enable',
    providerDisplayName: 'Enable provider',
    providerIconUrl: null,
    modelCount: 1,
    trains: false,
    retainsPrompts: false,
  },
  {
    providerSlug: 'enabled',
    providerDisplayName: 'Enabled provider',
    providerIconUrl: null,
    modelCount: 1,
    trains: false,
    retainsPrompts: false,
  },
  {
    providerSlug: 'unavailable',
    providerDisplayName: 'Unavailable provider',
    providerIconUrl: null,
    modelCount: 1,
    trains: false,
    retainsPrompts: false,
    unavailableReason: 'Unavailable',
  },
  {
    providerSlug: 'enabled-unavailable',
    providerDisplayName: 'Enabled unavailable provider',
    providerIconUrl: null,
    modelCount: 1,
    trains: false,
    retainsPrompts: false,
    unavailableReason: 'Unavailable',
  },
];

let ModelsTab!: typeof ModelsTabComponent;
let ProvidersTab!: typeof ProvidersTabComponent;
let ModelAccessPolicyEditor!: typeof ModelAccessPolicyEditorComponent;

beforeAll(async () => {
  ({ ModelsTab } = await import('./ModelsTab'));
  ({ ProvidersTab } = await import('./ProvidersTab'));
  ({ ModelAccessPolicyEditor } =
    await import('../groups/policies/model-access/ModelAccessPolicyEditor'));
});

describe('providers and models tabs', () => {
  let root: Root | undefined;
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    cleanup?.();
    cleanup = undefined;
  });

  function mount(node: React.ReactNode) {
    const dom = installDom();
    cleanup = dom.cleanup;
    root = createRoot(dom.container);
    act(() => root?.render(node));
    return dom.container;
  }

  function modelProps(overrides: Partial<React.ComponentProps<typeof ModelsTab>> = {}) {
    return {
      isLoading: false,
      canEdit: true,
      search: '',
      enabledOnly: false,
      onSearchChange: jest.fn(),
      onEnabledOnlyChange: jest.fn(),
      allowedModelIds: new Set(['vendor/enabled', 'vendor/enabled-unavailable', 'vendor/hidden']),
      enabledProviderSlugs: new Set<string>(),
      filteredModelRows: modelRows,
      onToggleModelAllowed: jest.fn(),
      onSetModelsAllowed: jest.fn(),
      onOpenModelDetails: jest.fn(),
      showDetails: false,
      ...overrides,
    };
  }

  function providerProps(overrides: Partial<React.ComponentProps<typeof ProvidersTab>> = {}) {
    return {
      isLoading: false,
      canEdit: true,
      search: '',
      enabledOnly: false,
      providerTrainsFilter: 'all' as const,
      providerRetainsPromptsFilter: 'all' as const,
      providerLocationsFilter: [],
      providerLocationOptions: [],
      filteredProviderRows: providerRows,
      enabledProviderSlugs: new Set(['enabled', 'enabled-unavailable', 'hidden']),
      enabledModelCountByProviderSlug: new Map<string, number>(),
      onSearchChange: jest.fn(),
      onEnabledOnlyChange: jest.fn(),
      onProviderTrainsFilterChange: jest.fn(),
      onProviderRetainsPromptsFilterChange: jest.fn(),
      onProviderLocationsFilterChange: jest.fn(),
      onToggleProviderEnabled: jest.fn(),
      onSetProvidersEnabled: jest.fn(),
      onOpenProviderDetails: jest.fn(),
      showDetails: false,
      ...overrides,
    };
  }

  for (const scope of ['organization', 'group'] as const) {
    it(`counts and changes only eligible shown models in ${scope} scope`, () => {
      const props = modelProps({ scope });
      const container = mount(createElement(ModelsTab, props));
      expect(container.textContent).toContain('Show enabled only');
      expect(container.textContent).toContain('3 enabled • 4 shown');
      const enable = button(container, 'Enable all shown (1)');
      const disable = button(container, 'Disable all shown (2)');
      expect(enable.disabled).toBe(false);
      expect(disable.disabled).toBe(false);
      click(enable);
      click(disable);
      expect(props.onSetModelsAllowed).toHaveBeenNthCalledWith(1, ['vendor/enable'], true);
      expect(props.onSetModelsAllowed).toHaveBeenNthCalledWith(
        2,
        ['vendor/enabled', 'vendor/enabled-unavailable'],
        false
      );
    });

    it(`counts and changes only eligible shown providers in ${scope} scope`, () => {
      const props = providerProps({ scope });
      const container = mount(createElement(ProvidersTab, props));
      expect(container.textContent).toContain('Show enabled only');
      expect(container.textContent).toContain('3 enabled • 4 shown');
      const enable = button(container, 'Enable all shown (1)');
      const disable = button(container, 'Disable all shown (2)');
      expect(enable.disabled).toBe(false);
      expect(disable.disabled).toBe(false);
      click(enable);
      click(disable);
      expect(props.onSetProvidersEnabled).toHaveBeenNthCalledWith(1, ['enable'], true);
      expect(props.onSetProvidersEnabled).toHaveBeenNthCalledWith(
        2,
        ['enabled', 'enabled-unavailable'],
        false
      );
    });
  }

  it('disables model bulk actions for empty and read-only results and hides them while loading', () => {
    const props = modelProps({ filteredModelRows: [] });
    const container = mount(createElement(ModelsTab, props));
    expect(button(container, 'Enable all shown (0)').disabled).toBe(true);
    expect(button(container, 'Disable all shown (0)').disabled).toBe(true);
    act(() => root?.render(createElement(ModelsTab, modelProps({ canEdit: false }))));
    expect(button(container, 'Enable all shown (1)').disabled).toBe(true);
    expect(button(container, 'Disable all shown (2)').disabled).toBe(true);
    act(() => root?.render(createElement(ModelsTab, modelProps({ isLoading: true }))));
    expect(container.textContent).toContain('Loading models...');
    expect(container.querySelector('button')).toBeNull();
  });

  it('disables provider bulk actions for empty and read-only results and hides them while loading', () => {
    const props = providerProps({ filteredProviderRows: [] });
    const container = mount(createElement(ProvidersTab, props));
    expect(button(container, 'Enable all shown (0)').disabled).toBe(true);
    expect(button(container, 'Disable all shown (0)').disabled).toBe(true);
    act(() => root?.render(createElement(ProvidersTab, providerProps({ canEdit: false }))));
    expect(button(container, 'Enable all shown (1)').disabled).toBe(true);
    expect(button(container, 'Disable all shown (2)').disabled).toBe(true);
    act(() => root?.render(createElement(ProvidersTab, providerProps({ isLoading: true }))));
    expect(container.textContent).toContain('Loading providers...');
    expect(container.querySelector('button')).toBeNull();
  });

  it('empties enabled-only model results after disabling the shown rows', () => {
    function Harness() {
      const [enabled, setEnabled] = useState(
        new Set(['vendor/enabled', 'vendor/enabled-unavailable'])
      );
      return createElement(
        ModelsTab,
        modelProps({
          enabledOnly: true,
          allowedModelIds: enabled,
          filteredModelRows: modelRows.filter(row => enabled.has(row.modelId)),
          onSetModelsAllowed: (ids, next) =>
            setEnabled(current => {
              const result = new Set(current);
              ids.forEach(id => (next ? result.add(id) : result.delete(id)));
              return result;
            }),
        })
      );
    }
    const container = mount(createElement(Harness));
    expect(button(container, 'Enable all shown (0)').disabled).toBe(true);
    click(button(container, 'Disable all shown (2)'));
    expect(container.textContent).toContain('0 enabled • 0 shown');
    expect(button(container, 'Enable all shown (0)').disabled).toBe(true);
    expect(button(container, 'Disable all shown (0)').disabled).toBe(true);
    expect(container.textContent).not.toContain('Enabled model');
  });

  it('empties enabled-only provider results after disabling the shown rows', () => {
    function Harness() {
      const [enabled, setEnabled] = useState(new Set(['enabled', 'enabled-unavailable']));
      return createElement(
        ProvidersTab,
        providerProps({
          enabledOnly: true,
          enabledProviderSlugs: enabled,
          filteredProviderRows: providerRows.filter(row => enabled.has(row.providerSlug)),
          onSetProvidersEnabled: (ids, next) =>
            setEnabled(current => {
              const result = new Set(current);
              ids.forEach(id => (next ? result.add(id) : result.delete(id)));
              return result;
            }),
        })
      );
    }
    const container = mount(createElement(Harness));
    expect(button(container, 'Enable all shown (0)').disabled).toBe(true);
    click(button(container, 'Disable all shown (2)'));
    expect(container.textContent).toContain('0 enabled • 0 shown');
    expect(button(container, 'Enable all shown (0)').disabled).toBe(true);
    expect(button(container, 'Disable all shown (0)').disabled).toBe(true);
    expect(container.textContent).not.toContain('Enabled provider');
  });

  it('preserves hidden group selections when bulk actions are saved', () => {
    const onSave = jest.fn();
    const container = mount(
      createElement(ModelAccessPolicyEditor, {
        organizationId: 'organization',
        policy: {
          type: 'model_access',
          data: {
            mode: 'selected',
            model_allow_list: ['vendor/hidden-model'],
            provider_allow_list: ['hidden-provider'],
          },
        },
        isSaving: false,
        onSave,
        onCancel: jest.fn(),
      })
    );
    const enables = Array.from(container.querySelectorAll('button')).filter(
      item => item.textContent?.trim() === 'Enable all shown (1)'
    );
    expect(enables).toHaveLength(2);
    enables.forEach(click);
    click(button(container, 'Save policy'));
    expect(onSave).toHaveBeenLastCalledWith({
      type: 'model_access',
      data: {
        mode: 'selected',
        model_allow_list: ['vendor/hidden-model', 'vendor/shown-model'],
        provider_allow_list: ['hidden-provider', 'shown-provider'],
      },
    });
    const disables = Array.from(container.querySelectorAll('button')).filter(
      item => item.textContent?.trim() === 'Disable all shown (1)'
    );
    expect(disables).toHaveLength(2);
    disables.forEach(click);
    click(button(container, 'Save policy'));
    expect(onSave).toHaveBeenLastCalledWith({
      type: 'model_access',
      data: {
        mode: 'selected',
        model_allow_list: ['vendor/hidden-model'],
        provider_allow_list: ['hidden-provider'],
      },
    });
  });
});
