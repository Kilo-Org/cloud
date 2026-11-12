import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTRPCClient } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import type { RootRouter } from '@/routers/root-router';
import { TRPCProvider } from '@/lib/trpc/utils';
import { useBuiltinAgentSettings, useSetBuiltinAgentsMutation } from './useCloudAgentSettings';

it.each([undefined, 'org-1'])(
  'updates the shared picker cache after saving with organizationId=%s',
  async organizationId => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const returnedAgents = { plan: { disable: true }, ask: { disable: true } };
    const trpcClient = createTRPCClient<RootRouter>({
      links: [
        () => () =>
          observable(observer => {
            observer.next({ result: { data: { success: true, agents: returnedAgents } } });
            observer.complete();
          }),
      ],
    });
    const trpc = createTRPCOptionsProxy<RootRouter>({ client: trpcClient, queryClient });
    const pickerKey = trpc.cloudAgentSettings.getBuiltinAgents.queryOptions(undefined).queryKey;
    const initialAgents = { plan: { disable: false } };
    queryClient.setQueryData(pickerKey, initialAgents);

    let save: ReturnType<typeof useSetBuiltinAgentsMutation>['mutateAsync'] | undefined;
    let pickerAgents: ReturnType<typeof useBuiltinAgentSettings>['data'];
    function Settings() {
      pickerAgents = useBuiltinAgentSettings().data;
      save = useSetBuiltinAgentsMutation(organizationId).mutateAsync;
      return null;
    }
    const element = createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(TRPCProvider, { trpcClient, queryClient, children: createElement(Settings) })
    );

    try {
      renderToStaticMarkup(element);
      expect(pickerAgents).toEqual(initialAgents);
      if (!save) throw new Error('Built-in agent mutation was not registered');

      await save({ agents: { plan: { disable: true } } });

      expect(queryClient.getQueryData(pickerKey)).toEqual(returnedAgents);
      renderToStaticMarkup(element);
      expect(pickerAgents).toEqual(returnedAgents);
    } finally {
      queryClient.clear();
    }
  }
);
