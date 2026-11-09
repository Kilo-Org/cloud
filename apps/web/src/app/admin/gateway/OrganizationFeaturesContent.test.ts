import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement, type ComponentProps } from 'react';
import type { Root } from 'react-dom/client';
import type { OrganizationFeatures } from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import type { OrganizationFeaturesContent as ContentComponent } from './OrganizationFeaturesContent';

const activeId = 'aaaaaaaa-1111-4111-8111-111111111111';
const deletedId = 'bbbbbbbb-2222-4222-8222-222222222222';
const unknownId = 'cccccccc-3333-4333-8333-333333333333';
const emptyFeatures: OrganizationFeatures = {
  experimental_byok: [],
  enkrypt_output_guardrail: [],
  gateway_settings: [],
  request_logs: [],
};
const mockMutate = jest.fn();
const mockRefetchConfig = jest.fn();
const mockRefetchPreview = jest.fn();
const mockConfigQuery: {
  data: OrganizationFeatures | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: typeof mockRefetchConfig;
} = {
  data: emptyFeatures,
  isLoading: false,
  error: null,
  refetch: mockRefetchConfig,
};
const mockPreviewQuery: {
  data: { id: string; name: string; isDeleted: boolean }[] | undefined;
  isPending: boolean;
  error: Error | null;
  refetch: typeof mockRefetchPreview;
} = { data: [], isPending: false, error: null, refetch: mockRefetchPreview };
const mockPreviewOptions = jest.fn(
  (input: OrganizationFeatures, options: { enabled: boolean }) => ({
    kind: 'preview',
    input,
    ...options,
  })
);

jest.mock('@tanstack/react-query', () => ({
  useQuery: ({ kind }: { kind: string }) =>
    kind === 'preview' ? mockPreviewQuery : mockConfigQuery,
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
  useMutation: () => ({ isPending: false, mutate: mockMutate }),
}));
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    admin: {
      gatewayConfig: {
        getOrganizationFeatures: {
          queryOptions: () => ({ kind: 'configuration' }),
          queryKey: () => ['organization-features'],
        },
        previewOrganizationFeatures: { queryOptions: mockPreviewOptions },
        setOrganizationFeatures: { mutationOptions: jest.fn() },
      },
    },
  }),
}));
jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock('next/link', () => ({
  __esModule: true,
  default: (props: ComponentProps<'a'>) => createElement('a', props),
}));

describe('OrganizationFeaturesContent', () => {
  let container: HTMLElement;
  let root: Root;
  let cleanup: () => void;
  let Content: typeof ContentComponent;

  beforeEach(async () => {
    jest.clearAllMocks();
    Object.assign(mockConfigQuery, {
      data: {
        experimental_byok: [activeId],
        enkrypt_output_guardrail: [],
        gateway_settings: [],
        request_logs: [],
      },
      isLoading: false,
      error: null,
    });
    Object.assign(mockPreviewQuery, {
      data: [{ id: activeId, name: 'Active organization', isDeleted: false }],
      isPending: false,
      error: null,
    });
    const { parseHTML } = createRequire(__filename)('linkedom') as {
      parseHTML: (html: string) => { window: typeof globalThis; document: Document };
    };
    const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
    document.oninput = null;
    const globals = {
      React,
      window,
      document,
      HTMLElement: window.HTMLElement,
      HTMLTextAreaElement: window.HTMLTextAreaElement,
      Event: window.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = new Map(
      Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
    );
    Object.assign(globalThis, globals);
    cleanup = () => {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    };
    const element = document.getElementById('root');
    if (!element) throw new Error('Test root missing');
    container = element;
    const { createRoot } = await import('react-dom/client');
    ({ OrganizationFeaturesContent: Content } = await import('./OrganizationFeaturesContent'));
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    cleanup?.();
  });

  function render() {
    act(() => root.render(createElement(Content)));
  }

  function edit(feature: keyof OrganizationFeatures, value: string) {
    const input = container.querySelector<HTMLTextAreaElement>(`#organization-feature-${feature}`);
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!input || !setter) throw new Error('Organization IDs textarea missing');
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function button(label: string) {
    const found = Array.from(container.querySelectorAll('button')).find(
      candidate => candidate.textContent === label
    );
    if (!found) throw new Error(`Button missing: ${label}`);
    return found;
  }

  it('shows organization names, IDs and admin links with deleted and unknown labels per feature', () => {
    mockConfigQuery.data = {
      experimental_byok: [activeId, unknownId],
      enkrypt_output_guardrail: [activeId],
      gateway_settings: [deletedId, activeId],
      request_logs: [activeId],
    };
    mockPreviewQuery.data?.push({ id: deletedId, name: 'Deleted organization', isDeleted: true });
    render();

    expect(container.textContent).toContain(
      'Lets the organization configure Enkrypt output guardrails in AI Guardrails. Existing output guardrails keep running when this feature is removed.'
    );
    const sections = Array.from(container.querySelectorAll('section'));
    expect(sections.map(section => section.querySelector('h3')?.textContent)).toEqual([
      'Direct Amazon Bedrock and Google Vertex AI BYOK (2)',
      'Enkrypt output guardrails (1)',
      'Gateway settings (2)',
      'Request logs (1)',
    ]);
    expect(sections[3].querySelector('a')?.textContent).toBe('Active organization');
    expect(sections[0].querySelector('a')?.textContent).toBe('Active organization');
    expect(sections[0].querySelector('a')?.getAttribute('href')).toBe(
      `/admin/organizations/${activeId}`
    );
    expect(Array.from(sections[0].querySelectorAll('code')).map(code => code.textContent)).toEqual([
      activeId,
      unknownId,
    ]);
    const unknown = sections[0].querySelectorAll('li')[1];
    expect(unknown.textContent).toContain('Organization not found');
    expect(unknown.querySelector('a')).toBeNull();
    const deleted = sections[2].querySelector('li');
    expect(deleted?.querySelector('a')?.textContent).toBe('Deleted organization');
    expect(deleted?.querySelector('a')?.getAttribute('href')).toBe(
      `/admin/organizations/${deletedId}`
    );
    expect(deleted?.textContent).toContain(deletedId);
    expect(deleted?.querySelector('[data-slot="badge"]')?.textContent).toBe('Deleted');
    expect(sections[0].textContent).not.toContain('Deleted');
    expect(container.textContent).toContain('Stored configuration');
    expect(button('Save').disabled).toBe(true);
  });

  it('previews unsaved textarea edits with trimmed, lowercase and deduplicated query input', () => {
    render();
    mockPreviewQuery.data = [{ id: deletedId, name: 'New organization', isDeleted: false }];
    edit('experimental_byok', ` ${deletedId.toUpperCase()} \n\n${deletedId}\n `);
    edit('enkrypt_output_guardrail', deletedId);
    edit('gateway_settings', ` ${deletedId.toUpperCase()} \n${deletedId}\n`);

    const input = {
      experimental_byok: [deletedId],
      enkrypt_output_guardrail: [deletedId],
      gateway_settings: [deletedId],
      request_logs: [],
    };
    expect(mockPreviewOptions).toHaveBeenLastCalledWith(input, {
      enabled: true,
    });
    expect(container.textContent).toContain('Unsaved changes');
    expect(container.textContent).not.toContain('Stored configuration');
    expect(container.textContent).not.toContain('Active organization');
    expect(
      Array.from(container.querySelectorAll('section a')).map(link => link.textContent)
    ).toEqual(['New organization', 'New organization', 'New organization']);
    expect(container.querySelectorAll('section li')).toHaveLength(3);
    expect(button('Save').disabled).toBe(false);
    expect(mockMutate).not.toHaveBeenCalled();
    act(() => button('Save').click());
    expect(mockMutate).toHaveBeenCalledWith(input);
  });

  it('announces preview loading and offers a retry on lookup failure without blocking the editor', () => {
    Object.assign(mockPreviewQuery, { data: undefined, isPending: true });
    render();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Loading organization names...'
    );
    expect(container.textContent).not.toContain('Organization not found');

    Object.assign(mockPreviewQuery, { isPending: false, error: new Error('Lookup unavailable') });
    render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not load organization names: Lookup unavailable'
    );
    act(() => button('Try again').click());
    expect(mockRefetchPreview).toHaveBeenCalledTimes(1);
    expect(mockRefetchConfig).not.toHaveBeenCalled();
    edit('gateway_settings', deletedId);
    expect(button('Save').disabled).toBe(false);

    Object.assign(mockPreviewQuery, {
      data: [{ id: activeId, name: 'Recovered organization', isDeleted: false }],
      error: null,
    });
    render();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('Recovered organization');
  });

  it('shows configuration loading and retries configuration errors before looking up names', () => {
    Object.assign(mockConfigQuery, { data: undefined, isLoading: true });
    render();
    expect(container.textContent).toBe('Loading...');
    expect(mockPreviewOptions).not.toHaveBeenCalled();

    Object.assign(mockConfigQuery, {
      isLoading: false,
      error: new Error('Configuration unavailable'),
    });
    render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not load organization features: Configuration unavailable'
    );
    act(() => button('Try again').click());
    expect(mockRefetchConfig).toHaveBeenCalledTimes(1);
    expect(mockRefetchPreview).not.toHaveBeenCalled();
    expect(mockPreviewOptions).not.toHaveBeenCalled();
  });

  it('shows empty feature lists without enabling a lookup, including whitespace-only edits', () => {
    mockConfigQuery.data = emptyFeatures;
    Object.assign(mockPreviewQuery, { data: undefined, isPending: true });
    render();
    edit('experimental_byok', ' \n\t\n ');

    expect(mockPreviewOptions.mock.calls.every(([, options]) => !options.enabled)).toBe(true);
    expect(mockPreviewOptions).toHaveBeenLastCalledWith(emptyFeatures, {
      enabled: false,
    });
    expect(Array.from(container.querySelectorAll('section p')).map(p => p.textContent)).toEqual(
      Array.from({ length: 4 }, () => 'No organizations enabled.')
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('section li')).toBeNull();
  });

  it.each([
    ['invalid UUID', 'not-an-organization-id'],
    ['over 1,000 IDs', Array.from({ length: 1001 }, () => activeId).join('\n')],
  ])('disables preview lookup for %s and removes stale names', (_label, value) => {
    render();
    mockPreviewOptions.mockClear();
    edit('experimental_byok', value);

    expect(mockPreviewOptions).toHaveBeenLastCalledWith(emptyFeatures, {
      enabled: false,
    });
    expect(mockPreviewOptions.mock.calls.every(([, options]) => !options.enabled)).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Enter valid organization IDs to see the preview. Each feature supports up to 1,000 IDs.'
    );
    expect(container.querySelector('section')).toBeNull();
    expect(container.textContent).not.toContain('Active organization');
    expect(mockMutate).not.toHaveBeenCalled();
  });
});
