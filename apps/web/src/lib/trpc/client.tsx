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
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { createNoRetryEventSource } from '@/lib/trpc/noRetryEventSource';
import { stepUpLink } from '@/lib/trpc/step-up-link';

function getUrl(endpoint: string) {
  const base = (() => {
    if (typeof window !== 'undefined') return '';
    if (buildInfo.vercelUrl) return `https://${buildInfo.vercelUrl}`;
    return APP_URL;
  })();
  return `${base}${endpoint}`;
}

/**
 * `endpoint` defaults to the main tRPC entry point. The app shell mounts this
 * again with its own entry point, because its session cookie only covers
 * `/app-shell` and the main entry point never reads it.
 */
export function TRPCContext(props: { children: React.ReactNode; endpoint?: string }) {
  const endpoint = props.endpoint ?? '/api/trpc';
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
            url: getUrl(endpoint),
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
                url: getUrl(endpoint),
              }),
              false: httpBatchLink({
                url: getUrl(endpoint),
              }),
            }),
          }),
        ]
      : [
          splitLink({
            condition: op => op.context.skipBatch === true,
            true: httpLink({
              url: getUrl(endpoint),
            }),
            false: httpBatchLink({
              url: getUrl(endpoint),
            }),
          }),
        ];

    return createTRPCClient<RootRouter>({
      links: [
        stepUpLink(),
        splitLink({
          condition: op => op.path === 'admin.gatewayConfig.previewOrganizationFeatures',
          true: httpLink({ url: getUrl(endpoint), methodOverride: 'POST' }),
          false: links,
        }),
      ],
    });
  });
  return (
    <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
      {props.children}
    </TRPCProvider>
  );
}
