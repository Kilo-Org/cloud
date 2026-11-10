import { afterEach, describe, expect, it } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { BYOKApiKeyResponse } from '@/lib/byok/types';
import {
  BYOKKeysManager,
  getStructuredCredentialKind,
  VERCEL_BYOK_PROVIDER_NAMES,
} from './BYOKKeysManager';

type ListInput = { organizationId?: string };
type ReorderInput = ListInput & { keyIds: string[] };

const listKey = (input: ListInput) => ['byok', 'list', input];
let mockKeys: BYOKApiKeyResponse[] = [];
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
        experimentalByokEnabled: {
          queryOptions: () => ({ queryKey: ['byok', 'experimental'], queryFn: async () => false }),
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
        testApiKey: mutation,
      },
    };
  },
}));

jest.mock('@/components/ui/confirm', () => ({ useConfirm: () => jest.fn() }));
jest.mock('@/components/ui/switch', () => ({ Switch: () => null }));
jest.mock('./BYOKRoutingPreview', () => ({ BYOKRoutingPreview: () => null }));
jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

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
  const container = document.getElementById('root');
  if (!container) throw new Error('React root missing');
  return {
    container,
    cleanup: () => previous.forEach((value, name) => (globals[name] = value)),
  };
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
  let cleanup: (() => void) | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    queryClient?.clear();
    queryClient = undefined;
    cleanup?.();
    cleanup = undefined;
    mockReorder.mockClear();
    jest.mocked(toast.error).mockClear();
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
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient = client;
    client.setQueryData(listKey(organizationId ? { organizationId } : {}), mockKeys);
    const dom = installDom();
    cleanup = dom.cleanup;
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
});
