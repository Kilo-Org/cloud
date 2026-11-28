import { afterAll, afterEach, describe, expect, it } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { BYOKApiKeyResponse } from '@/lib/byok/types';
import { getByokProviderDisplayName, VERCEL_BYOK_PROVIDER_NAMES } from '@/lib/byok/provider-names';
import { BYOKKeysManager, getStructuredCredentialKind } from './BYOKKeysManager';

type ListInput = { organizationId?: string };
type ReorderInput = ListInput & { keyIds: string[] };

const listKey = (input: ListInput) => ['byok', 'list', input];
let mockKeys: BYOKApiKeyResponse[] = [];
let mockByokPrivateProvidersEnabled = false;
/** The options the screen registered for the stored-key test, so a test can run its handlers. */
let mockTestApiKeyOptions:
  | { onSuccess?: (result: unknown, variables: { id: string }) => void }
  | undefined;
const mockReorder = jest.fn(async ({ keyIds }: ReorderInput) => {
  mockKeys = keyIds.map(id => {
    const key = mockKeys.find(key => key.id === id);
    if (!key) throw new Error(`Unknown key: ${id}`);
    return key;
  });
  return mockKeys;
});

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => {
    const mutation = {
      mutationOptions: (options: object) => ({ ...options, mutationFn: jest.fn() }),
    };
    return {
      byok: {
        list: {
          queryKey: listKey,
          queryOptions: (input: ListInput) => ({
            queryKey: listKey(input),
            queryFn: async () => mockKeys,
          }),
        },
        listSupportedModels: {
          queryOptions: () => ({ queryKey: ['byok', 'models'], queryFn: async () => ({}) }),
        },
        listCatalogModeSupportedModels: {
          queryOptions: () => ({ queryKey: ['byok', 'catalog-models'], queryFn: async () => ({}) }),
        },
        listPrivateProviderCatalogModelIds: {
          queryOptions: (input: object) => ({
            queryKey: ['byok', 'private-provider-catalog-models', input],
            queryFn: async () => [],
          }),
        },
        experimentalByokEnabled: {
          queryOptions: () => ({ queryKey: ['byok', 'experimental'], queryFn: async () => false }),
        },
        privateProvidersEnabled: {
          queryOptions: (input: ListInput) => ({
            queryKey: ['byok', 'private providers-enabled', input],
            queryFn: async () => mockByokPrivateProvidersEnabled,
          }),
        },
        previewRouting: { pathFilter: () => ({ queryKey: ['byok', 'previewRouting'] }) },
        create: mutation,
        update: mutation,
        delete: mutation,
        setEnabled: mutation,
        setCatalogMode: mutation,
        reorder: {
          mutationOptions: (options: object) => ({ ...options, mutationFn: mockReorder }),
        },
        testApiKey: {
          mutationOptions: (options: object) => {
            mockTestApiKeyOptions = options as typeof mockTestApiKeyOptions;
            return { ...options, mutationFn: jest.fn() };
          },
        },
        createPrivateProvider: mutation,
        updatePrivateProvider: mutation,
        listModelsFromPrivateProvider: mutation,
      },
    };
  },
}));

jest.mock('@/components/ui/confirm', () => ({ useConfirm: () => jest.fn() }));
jest.mock('@/components/ui/switch', () => ({ Switch: () => null }));
jest.mock('./BYOKRoutingPreview', () => ({ BYOKRoutingPreview: () => null }));
jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

/**
 * How to put each installed DOM global back. React attributes an update with a
 * timer that reads `window`, and that timer can still be queued when a test
 * ends, so the DOM globals outlive every test of this file and are restored
 * once, after the last one.
 */
const domRestores: (() => void)[] = [];

afterAll(() => {
  for (const restore of domRestores.splice(0).reverse()) {
    restore();
  }
});

function installDom() {
  const requireFromHere = createRequire(__filename);
  const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));
  const { window, document } = (
    requireFromNext('linkedom') as {
      parseHTML: (html: string) => { window: Record<string, unknown>; document: Document };
    }
  ).parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const previous = new Map<string, unknown>();
  const values = {
    React,
    window,
    document,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, globals[name]);
    globals[name] = value;
  }
  domRestores.push(() => previous.forEach((value, name) => (globals[name] = value)));
  const container = document.getElementById('root');
  if (!container) throw new Error('React root missing');
  return { container };
}

// The personal BYOK page renders the "Sign in with ChatGPT" connection card
// above this key list, and the Add Key dialog offers these entries. The pasted
// OpenAI key therefore names the credential it holds; nothing here may read as
// the same 'OpenAI' as the ChatGPT connection card.
describe('BYOKKeysManager provider names', () => {
  it('offers Cohere as a Vercel BYOK provider', () => {
    expect(VERCEL_BYOK_PROVIDER_NAMES.cohere).toBe('Cohere');
  });

  it('uses the current Novita AI and SpaceXSI provider names', () => {
    expect(VERCEL_BYOK_PROVIDER_NAMES.novita).toBe('Novita AI');
    expect(VERCEL_BYOK_PROVIDER_NAMES.xai).toBe('SpaceXSI');
  });

  it('names the pasted OpenAI entry for the credential it holds', () => {
    expect(VERCEL_BYOK_PROVIDER_NAMES.openai).toBe('OpenAI API key');
  });

  it('leaves no entry named exactly "OpenAI"', () => {
    expect(Object.values(VERCEL_BYOK_PROVIDER_NAMES)).not.toContain('OpenAI');
  });
});

describe('getStructuredCredentialKind', () => {
  it.each([
    ['azure', 'azure'],
    ['bedrock', 'bedrock'],
    ['bedrock-byok', 'bedrock'],
    ['vertex', 'vertex'],
    ['vertex-byok', 'vertex'],
  ] as const)('maps %s to %s JSON credentials', (providerId, kind) => {
    expect(getStructuredCredentialKind(providerId)).toBe(kind);
  });

  it.each(['anthropic', 'cohere', 'openai', 'codestral', ''])(
    'uses a single API key for %j',
    providerId => {
      expect(getStructuredCredentialKind(providerId)).toBeNull();
    }
  );
});

describe('BYOK key priorities', () => {
  let root: Root | undefined;
  let queryClient: QueryClient | undefined;

  afterEach(async () => {
    await act(async () => new Promise(resolve => setTimeout(resolve)));
    await act(async () => root?.unmount());
    root = undefined;
    queryClient?.clear();
    queryClient = undefined;
    mockReorder.mockClear();
    jest.mocked(toast.error).mockClear();
    mockByokPrivateProvidersEnabled = false;
  });

  async function mount(organizationId?: string, providers = ['anthropic', 'openrouter']) {
    mockKeys = providers.map(provider_id => ({
      id: `${provider_id}-key`,
      provider_id,
      provider_name: provider_id,
      management_source: 'user',
      is_enabled: true,
      serve_catalog_models: false,
      supports_catalog_mode: false,
      can_change_catalog_mode: false,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      created_by: 'test-user',
      is_private_provider: false,
      private_provider: null,
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient = client;
    client.setQueryData(listKey(organizationId ? { organizationId } : {}), mockKeys);
    client.setQueryData(
      ['byok', 'private providers-enabled', organizationId ? { organizationId } : {}],
      mockByokPrivateProvidersEnabled
    );
    const dom = installDom();
    root = createRoot(dom.container);
    await act(async () => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(BYOKKeysManager, { organizationId })
        )
      );
    });
    return dom.container;
  }

  it.each([undefined, 'test-org'])('shows priority controls for scope %s', async organizationId => {
    const container = await mount(organizationId);
    const up = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Move Anthropic API key up"]'
    );
    const down = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Move Anthropic API key down"]'
    );
    expect(up?.disabled).toBe(true);
    expect(down?.disabled).toBe(false);
    expect(
      container.textContent?.includes('This key order applies to all organization members.')
    ).toBe(!!organizationId);
  });

  it.each([undefined, 'test-org'])(
    'hides priority controls for one listed key in scope %s',
    async organizationId => {
      const container = await mount(organizationId, ['anthropic', 'openai-chatgpt']);
      expect(container.querySelector('button[aria-label^="Move "]')).toBeNull();
    }
  );

  it.each([undefined, 'test-org'])('saves reordered keys in scope %s', async organizationId => {
    const container = await mount(organizationId);
    const otherScope = listKey(organizationId ? {} : { organizationId: 'other-org' });
    const otherKeys = [{ id: 'untouched-key' }];
    queryClient?.setQueryData(otherScope, otherKeys);
    const down = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Move Anthropic API key down"]'
    );
    if (!down) throw new Error('Priority control missing');

    await act(async () => down.click());

    expect(mockReorder.mock.calls[0]?.[0]).toEqual({
      ...(organizationId ? { organizationId } : {}),
      keyIds: ['openrouter-key', 'anthropic-key'],
    });
    expect(queryClient?.getQueryData(listKey(organizationId ? { organizationId } : {}))).toEqual(
      mockKeys
    );
    expect(queryClient?.getQueryData(otherScope)).toEqual(otherKeys);
  });

  it('restores the organization order when saving fails', async () => {
    const container = await mount('test-org');
    const previousKeys = [...mockKeys];
    mockReorder.mockRejectedValueOnce(new Error('Permission denied'));
    const down = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Move Anthropic API key down"]'
    );
    if (!down) throw new Error('Priority control missing');

    await act(async () => down.click());

    expect(queryClient?.getQueryData(listKey({ organizationId: 'test-org' }))).toEqual(
      previousKeys
    );
    expect(toast.error).toHaveBeenCalledWith('Failed to save key priority: Permission denied');
  });

  it.each([
    [true, true],
    [false, false],
  ])(
    'with BYOK private providers enabled %s, shows the Add private provider button: %s',
    async (enabled, shown) => {
      mockByokPrivateProvidersEnabled = enabled;
      const container = await mount('test-org');
      const buttons = [...container.querySelectorAll('button')];
      expect(buttons.some(button => button.textContent?.includes('Add private provider'))).toBe(
        shown
      );
    }
  );
});

describe('BYOK stored-key test toasts', () => {
  let root: Root | undefined;
  let queryClient: QueryClient | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    queryClient?.clear();
    queryClient = undefined;
    mockTestApiKeyOptions = undefined;
    jest.mocked(toast.error).mockClear();
    jest.mocked(toast.success).mockClear();
  });

  async function mount(providerId = 'anthropic') {
    mockKeys = [
      {
        id: 'anthropic-key',
        provider_id: providerId,
        provider_name: getByokProviderDisplayName(providerId),
        management_source: 'user',
        is_enabled: true,
        serve_catalog_models: false,
        supports_catalog_mode: false,
        can_change_catalog_mode: false,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        created_by: 'test-user',
        is_private_provider: false,
        private_provider: null,
      },
    ];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient = client;
    client.setQueryData(listKey({}), mockKeys);
    const dom = installDom();
    root = createRoot(dom.container);
    await act(async () => {
      root?.render(
        createElement(QueryClientProvider, { client }, createElement(BYOKKeysManager, {}))
      );
    });
    if (!mockTestApiKeyOptions?.onSuccess) throw new Error('Test mutation was never created');
    return mockTestApiKeyOptions.onSuccess;
  }

  it('names the stored provider that rejected the key', async () => {
    const onSuccess = await mount();

    await act(async () => {
      onSuccess(
        { outcome: 'rejected', success: false, message: 'legacy sentence' },
        { id: 'anthropic-key' }
      );
    });

    expect(toast.error).toHaveBeenCalledWith(
      'API key test failed: Anthropic rejected this API key. Check that the key is correct and has not been revoked.'
    );
  });

  it('reports a rejected key without naming a provider when the key is not in the list', async () => {
    const onSuccess = await mount();

    await act(async () => {
      onSuccess(
        { outcome: 'rejected', success: false, message: 'legacy sentence' },
        { id: 'gone-key' }
      );
    });

    expect(toast.error).toHaveBeenCalledWith(
      'API key test failed: the provider rejected this API key. Check that the key is correct and has not been revoked.'
    );
  });

  it('names the stored provider of a deprecated key', async () => {
    const onSuccess = await mount('codestral');

    await act(async () => {
      onSuccess(
        { outcome: 'deprecated-provider', success: false, message: 'legacy sentence' },
        { id: 'anthropic-key' }
      );
    });

    expect(toast.error).toHaveBeenCalledWith(
      'Legacy Codestral-only key is deprecated and its API key can no longer be tested.'
    );
  });

  it('keeps the provider sentence for a failure that has no other reason', async () => {
    const onSuccess = await mount();

    await act(async () => {
      onSuccess(
        { outcome: 'failed', detail: 'upstream said 401', success: false, message: 'legacy' },
        { id: 'anthropic-key' }
      );
    });

    expect(toast.error).toHaveBeenCalledWith('API key test failed: upstream said 401');
  });

  it('drops the terminal colour codes a provider SDK puts in its sentence', async () => {
    const onSuccess = await mount();

    await act(async () => {
      onSuccess(
        {
          outcome: 'failed',
          detail: '\u001b[1m\u001b[31mUnauthenticated request.\u001b[0m Check the key.',
          success: false,
          message: 'legacy',
        },
        { id: 'anthropic-key' }
      );
    });

    expect(toast.error).toHaveBeenCalledWith(
      'API key test failed: Unauthenticated request. Check the key.'
    );
  });

  it('names the provider that is still listed when its id is gone from the catalog', async () => {
    const onSuccess = await mount();

    await act(async () => {
      onSuccess(
        { outcome: 'unsupported-provider', success: false, message: 'legacy' },
        { id: 'anthropic-key' }
      );
    });

    expect(toast.error).toHaveBeenCalledWith('Provider anthropic is no longer supported.');
  });

  it('reports a successful test with the provider and model the server chose', async () => {
    const onSuccess = await mount();

    await act(async () => {
      onSuccess(
        {
          outcome: 'ok',
          provider: 'Anthropic',
          model: 'claude-sonnet-4',
          success: true,
          message: 'legacy',
        },
        { id: 'anthropic-key' }
      );
    });

    expect(toast.success).toHaveBeenCalledWith(
      'API key test success. Provider: Anthropic. Model: claude-sonnet-4.'
    );
  });
});
