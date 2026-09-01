import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TriggerFormData, TriggerFormProps } from '@/components/webhook-triggers/TriggerForm';
import type { EditWebhookTriggerContent as EditWebhookTriggerContentComponent } from './EditWebhookTriggerContent';

let formProps: TriggerFormProps | undefined;
const updateMutation = jest.fn<(input: unknown) => Promise<unknown>>();
const invokeTrigger = jest.fn<(triggerId: string) => Promise<unknown>>();
const invalidateQueries = jest.fn();
const refetchTrigger = jest.fn();

jest.mock('@/components/webhook-triggers/TriggerForm', () => ({
  TriggerForm: (props: TriggerFormProps) => {
    formProps = props;
    return null;
  },
}));
jest.mock('@/components/webhook-triggers', () => ({
  useInvokeWebhookTrigger: () => ({ invokeTrigger, isInvoking: false, invokingTriggerId: null }),
}));
jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: { kind: string }) => {
    if (options.kind === 'capabilities') return { data: { canSetSandboxAllocation: true } };
    if (options.kind === 'trigger') {
      return {
        data: {
          triggerId: 'daily-report',
          activationMode: 'scheduled',
          cronExpression: '0 9 * * *',
          cronTimezone: 'UTC',
          githubRepo: 'kilo/cloud',
          mode: 'ask',
          model: 'alpha',
          promptTemplate: 'Saved prompt',
          profileId: 'profile-1',
          isActive: true,
          targetType: 'cloud_agent',
        },
        isLoading: false,
        refetch: refetchTrigger,
      };
    }
    return { data: { repositories: [] }, isLoading: false };
  },
  useMutation: (options: {
    kind: string;
    onSuccess?: () => void;
    onError?: (error: Error) => void;
  }) => ({
    mutateAsync: async (input: unknown) => {
      try {
        const result = await updateMutation(input);
        options.onSuccess?.();
        return result;
      } catch (error) {
        options.onError?.(error as Error);
        throw error;
      }
    },
    isPending: false,
  }),
  useQueryClient: () => ({ invalidateQueries }),
}));
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    webhookTriggers: {
      capabilities: { queryOptions: () => ({ kind: 'capabilities' }) },
      get: { queryOptions: () => ({ kind: 'trigger' }) },
      update: { mutationOptions: (options: object) => ({ kind: 'update', ...options }) },
      delete: { mutationOptions: (options: object) => ({ kind: 'delete', ...options }) },
      list: { queryKey: () => ['list'] },
    },
    cloudAgentNext: { listGitHubRepositories: { queryOptions: () => ({ kind: 'repos' }) } },
    organizations: {
      cloudAgentNext: { listGitHubRepositories: { queryOptions: () => ({ kind: 'repos' }) } },
    },
  }),
}));
jest.mock('@/app/api/openrouter/hooks', () => ({
  useModelSelectorList: () => ({ data: { data: [] } }),
}));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('sonner', () => ({ toast: { error: jest.fn(), success: jest.fn() } }));
jest.mock('lucide-react', () => new Proxy({}, { get: () => () => null }));
jest.mock('@/components/ui/button', () => ({
  Button: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/ui/skeleton', () => ({ Skeleton: () => null }));
jest.mock('@/components/ui/card', () => ({
  Card: ({ children }: { children: React.ReactNode }) => children,
  CardContent: ({ children }: { children: React.ReactNode }) => children,
  CardDescription: ({ children }: { children: React.ReactNode }) => children,
  CardHeader: ({ children }: { children: React.ReactNode }) => children,
  CardTitle: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/lib/webhook-routes', () => ({
  getWebhookRoutes: () => ({ list: '/', requests: () => '/' }),
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

let EditWebhookTriggerContent!: typeof EditWebhookTriggerContentComponent;

beforeAll(
  async () => ({ EditWebhookTriggerContent } = await import('./EditWebhookTriggerContent'))
);

describe('EditWebhookTriggerContent save and invoke', () => {
  let root: Root | undefined;
  let cleanup: (() => void) | undefined;
  const data: TriggerFormData = {
    triggerId: 'daily-report',
    activationMode: 'scheduled',
    cronExpression: '0 9 * * *',
    cronTimezone: 'UTC',
    githubRepo: 'kilo/cloud',
    mode: 'ask',
    model: 'alpha',
    promptTemplate: 'Current prompt',
    profileId: 'profile-1',
    webhookAuth: { enabled: false },
    isActive: true,
  };

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    cleanup?.();
    cleanup = undefined;
    formProps = undefined;
    updateMutation.mockReset();
    invokeTrigger.mockReset();
  });

  async function render() {
    const dom = installDom();
    cleanup = dom.cleanup;
    root = createRoot(dom.container);
    await act(async () => {
      root?.render(
        createElement(EditWebhookTriggerContent, {
          params: Promise.resolve({ triggerId: 'daily-report' }),
          organizationId: 'org-1',
        })
      );
      await Promise.resolve();
    });
    if (!formProps?.onSaveAndInvoke) throw new Error('save and invoke callback missing');
    return formProps.onSaveAndInvoke;
  }

  it('awaits the saved current configuration before invoking in the organization namespace', async () => {
    let resolveUpdate: () => void = () => undefined;
    updateMutation.mockReturnValue(
      new Promise<void>(resolve => {
        resolveUpdate = resolve;
      })
    );
    const onSaveAndInvoke = await render();
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = onSaveAndInvoke(data);
    });
    expect(invokeTrigger).not.toHaveBeenCalled();
    expect(updateMutation).toHaveBeenCalledWith(
      expect.objectContaining({ promptTemplate: 'Current prompt', organizationId: 'org-1' })
    );
    await act(async () => {
      resolveUpdate();
      await pending;
    });
    expect(invokeTrigger).toHaveBeenCalledWith('daily-report');
  });

  it('does not invoke when saving fails and permits retry after either failure', async () => {
    updateMutation.mockRejectedValueOnce(new Error('save failed')).mockResolvedValue(undefined);
    invokeTrigger
      .mockRejectedValueOnce(new Error('invoke failed'))
      .mockResolvedValueOnce({ requestId: 'request-1' });
    const onSaveAndInvoke = await render();
    await act(async () => {
      await onSaveAndInvoke(data);
    });
    expect(invokeTrigger).not.toHaveBeenCalled();
    await act(async () => {
      await onSaveAndInvoke(data);
    });
    expect(updateMutation).toHaveBeenCalledTimes(2);
    expect(invokeTrigger).toHaveBeenCalledTimes(1);
    await act(async () => {
      await onSaveAndInvoke(data);
    });
    expect(updateMutation).toHaveBeenCalledTimes(3);
    expect(invokeTrigger).toHaveBeenCalledTimes(2);
  });
});
