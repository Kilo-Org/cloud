import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TriggerFormData, TriggerFormProps } from '@/components/webhook-triggers/TriggerForm';
import type { CreateWebhookTriggerContent as CreateWebhookTriggerContentComponent } from './CreateWebhookTriggerContent';

let formProps: TriggerFormProps | undefined;
const mockCreateMutation =
  jest.fn<(input: unknown) => Promise<{ triggerId: string; inboundUrl: string }>>();
const mockInvalidateQueries = jest.fn();
const environmentId = '00000000-0000-4000-8000-000000000006';

jest.mock('@/components/webhook-triggers/TriggerForm', () => ({
  TriggerForm: (props: TriggerFormProps) => {
    formProps = props;
    return null;
  },
}));
jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: { kind: string }) => {
    if (options.kind === 'capabilities') {
      return {
        data: { canSetSandboxAllocation: false },
        isPending: false,
        isError: false,
        refetch: jest.fn(),
      };
    }
    if (options.kind === 'repos') {
      return {
        data: { repositories: [], integrationInstalled: true },
        isLoading: false,
      };
    }
    return { data: undefined, isLoading: false };
  },
  useMutation: (options: {
    onSuccess?: (data: { triggerId: string; inboundUrl: string }) => void;
    onError?: (error: Error) => void;
  }) => ({
    mutateAsync: async (input: unknown) => {
      try {
        const result = await mockCreateMutation(input);
        options.onSuccess?.(result);
        return result;
      } catch (error) {
        options.onError?.(error as Error);
        throw error;
      }
    },
    isPending: false,
  }),
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    webhookTriggers: {
      capabilities: { queryOptions: () => ({ kind: 'capabilities' }) },
      create: { mutationOptions: (options: object) => ({ kind: 'create', ...options }) },
      list: { queryKey: () => ['list'] },
    },
    cloudAgentNext: { listGitHubRepositories: { queryOptions: () => ({ kind: 'repos' }) } },
    organizations: {
      cloudAgentNext: { listGitHubRepositories: { queryOptions: () => ({ kind: 'repos' }) } },
    },
  }),
}));
jest.mock('@/lib/hooks/use-openrouter-models', () => ({
  useModelSelectorList: () => ({ data: { data: [] } }),
}));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/Button', () => ({
  LinkButton: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('sonner', () => ({ toast: { error: jest.fn(), success: jest.fn() } }));
jest.mock('lucide-react', () => new Proxy({}, { get: () => () => null }));
jest.mock('@/components/ui/button', () => ({
  Button: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/ui/card', () => ({
  Card: ({ children }: { children: React.ReactNode }) => children,
  CardContent: ({ children }: { children: React.ReactNode }) => children,
  CardDescription: ({ children }: { children: React.ReactNode }) => children,
  CardHeader: ({ children }: { children: React.ReactNode }) => children,
  CardTitle: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/lib/webhook-routes', () => ({
  getWebhookRoutes: () => ({ list: '/', edit: () => '/' }),
}));

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
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = parsed.document.getElementById('root');
  if (!container) throw new Error('root missing');
  return {
    container: container as HTMLElement,
    cleanup: () => previous.forEach((value, name) => (globals[name] = value)),
  };
}

let CreateWebhookTriggerContent!: typeof CreateWebhookTriggerContentComponent;

beforeAll(
  async () => ({ CreateWebhookTriggerContent } = await import('./CreateWebhookTriggerContent'))
);

describe('CreateWebhookTriggerContent environment mapping', () => {
  let root: Root | undefined;
  let cleanup: (() => void) | undefined;
  const data: TriggerFormData = {
    triggerId: 'daily-report',
    activationMode: 'webhook',
    githubRepo: 'kilo/cloud',
    mode: 'ask',
    model: 'alpha',
    promptTemplate: 'Current prompt',
    profileId: 'profile-1',
    webhookAuth: { enabled: false },
  };

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    cleanup?.();
    cleanup = undefined;
    formProps = undefined;
    mockCreateMutation.mockReset();
    mockInvalidateQueries.mockReset();
  });

  async function render() {
    const dom = installDom();
    cleanup = dom.cleanup;
    root = createRoot(dom.container);
    await act(async () => {
      root?.render(createElement(CreateWebhookTriggerContent, { organizationId: 'org-1' }));
      await Promise.resolve();
    });
    if (!formProps) throw new Error('form props missing');
    return formProps;
  }

  it('forwards a selected environment when creating a trigger', async () => {
    mockCreateMutation.mockResolvedValue({
      triggerId: 'daily-report',
      inboundUrl: 'https://inbound',
    });
    const props = await render();

    await act(async () => {
      await props.onSubmit({ ...data, environmentId });
    });

    expect(mockCreateMutation).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId, organizationId: 'org-1' })
    );
  });

  it('forwards Automatic as a null environment in the create payload', async () => {
    mockCreateMutation.mockResolvedValue({
      triggerId: 'daily-report',
      inboundUrl: 'https://inbound',
    });
    const props = await render();

    await act(async () => {
      await props.onSubmit({ ...data, environmentId: null });
    });
    expect(mockCreateMutation).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: null })
    );
  });
});
