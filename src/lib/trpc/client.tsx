'use client';
// ^-- to make sure we can mount the Provider from a server component
import { useQueryClient } from '@tanstack/react-query';
import {
  createTRPCClient,
  httpBatchLink,
  httpLink,
  httpSubscriptionLink,
  splitLink,
} from '@trpc/client';
import { useState } from 'react';
import type { RootRouter } from '@/routers/root-router';
import { TRPCProvider } from '@/lib/trpc/utils';
import { buildInfo } from '@/lib/buildInfo';
import { APP_URL } from '@/lib/constants';
import { createNoRetryEventSource } from '@/lib/trpc/noRetryEventSource';

function getUrl() {
  const base = (() => {
    if (typeof window !== 'undefined') return '';
    if (buildInfo.vercelUrl) return `https://${buildInfo.vercelUrl}`;
    return APP_URL;
  })();
  return `${base}/api/trpc`;
}

export function TRPCContext(props: { children: React.ReactNode }) {
  // NOTE: Avoid useState when initializing the query client if you don't
  //       have a suspense boundary between this and the code that may
  //       suspend because React will throw away the client on the initial
  //       render if it suspends and there is no boundary
  const queryClient = useQueryClient();
  const [trpcClient] = useState(() => {
    const subscriptionLink =
      typeof window === 'undefined'
        ? null
        : httpSubscriptionLink({
            url: getUrl(),
            EventSource: createNoRetryEventSource(EventSource),
            eventSourceOptions: () => ({}),
          });

    const links = subscriptionLink
      ? [
          splitLink({
            condition: op => op.type === 'subscription',
            true: subscriptionLink,
            false: splitLink({
              condition: op => op.context.skipBatch === true,
              true: httpLink({
                url: getUrl(),
              }),
              false: httpBatchLink({
                url: getUrl(),
              }),
            }),
          }),
        ]
      : [
          splitLink({
            condition: op => op.context.skipBatch === true,
            true: httpLink({
              url: getUrl(),
            }),
            false: httpBatchLink({
              url: getUrl(),
            }),
          }),
        ];

    return createTRPCClient<RootRouter>({
      links,
    });
  });
  return (
    <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
      {props.children}
    </TRPCProvider>
  );
}
