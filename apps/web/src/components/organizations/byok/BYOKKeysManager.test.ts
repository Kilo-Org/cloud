import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    byok: {
      ...Object.fromEntries(
        [
          ['list', []],
          ['listSupportedModels', {}],
          ['listCatalogModeSupportedModels', {}],
          ['experimentalByokEnabled', false],
        ].map(([name, data]) => [
          name,
          {
            queryOptions: () => ({
              queryKey: ['byok', name],
              queryFn: async () => data,
              initialData: data,
            }),
          },
        ])
      ),
      ...Object.fromEntries(
        ['create', 'update', 'delete', 'setEnabled', 'setCatalogMode', 'testApiKey'].map(name => [
          name,
          { mutationOptions: () => ({}) },
        ])
      ),
    },
  }),
}));

jest.mock('@/components/ui/confirm', () => ({ useConfirm: () => jest.fn() }));

jest.mock('@/components/organizations/byok/BYOKRoutingPreview', () => ({
  BYOKRoutingPreview: jest.fn(() =>
    createElement('div', { 'data-testid': 'byok-routing-preview' })
  ),
}));

import { BYOKRoutingPreview } from './BYOKRoutingPreview';
import {
  BYOKKeysManager,
  getStructuredCredentialKind,
  VERCEL_BYOK_PROVIDER_NAMES,
} from './BYOKKeysManager';

// The personal BYOK page renders the "Sign in with ChatGPT" connection card
// above this key list, and the Add Key dialog offers these entries. The pasted
// OpenAI key therefore names the credential it holds; nothing here may read as
// the same 'OpenAI' as the ChatGPT connection card.
describe('BYOKKeysManager provider names', () => {
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

  it.each(['anthropic', 'openai', 'codestral', ''])('uses a single API key for %j', providerId => {
    expect(getStructuredCredentialKind(providerId)).toBeNull();
  });
});

describe('BYOKKeysManager routing preview', () => {
  const previousReact = Reflect.get(globalThis, 'React');

  // The Jest transform uses classic JSX for components built with Next.js's automatic runtime.
  beforeAll(() => Object.assign(globalThis, { React }));
  afterAll(() => {
    if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React');
    else Reflect.set(globalThis, 'React', previousReact);
  });

  it.each([
    ['personal', undefined],
    ['organization', 'org-1'],
  ] as const)(
    'renders the %s preview when no API keys are configured',
    (_scope, organizationId) => {
      jest.mocked(BYOKRoutingPreview).mockClear();
      const queryClient = new QueryClient();
      const html = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(BYOKKeysManager, { organizationId })
        )
      );

      expect(html).toContain('No BYOK keys configured');
      expect(html).toContain('data-testid="byok-routing-preview"');
      expect(BYOKRoutingPreview).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId }),
        undefined
      );
    }
  );
});
