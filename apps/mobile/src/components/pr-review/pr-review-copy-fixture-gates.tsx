import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTRPCClient, httpLink } from '@trpc/client';
import { useState } from 'react';
import { View } from 'react-native';

import { PrReviewConnectGate } from '@/components/pr-review/pr-review-connect-gate';
import { type ProviderPrRef } from '@/lib/pr-review/provider-pr-ref';
import { TRPCProvider } from '@/lib/trpc';

// In a development build, open dev/pr-review-copy-fixture/<surface> for:
// gate-github-error, gate-gitlab-error, gate-bitbucket-error and
// gate-gitlab-admin-only. Each surface mounts the real connect gate over owned
// fake reads, so the gate's own state selection picks the arm under test:
// a status read that fails renders the check-failed title, and a GitLab
// connection that needs re-authorizing for a plain member renders the role
// guidance. Uses the app's selected language without changing its preference.

const GATE_SURFACES = [
  'gate-github-error',
  'gate-gitlab-error',
  'gate-bitbucket-error',
  'gate-gitlab-admin-only',
] as const;

export type PrReviewGateFixtureSurface = (typeof GATE_SURFACES)[number];

export function isGateSurface(surface: string | undefined): surface is PrReviewGateFixtureSurface {
  return GATE_SURFACES.some(candidate => candidate === surface);
}

const triple = { owner: 'sample', repo: 'review-copy', number: 1 };
const organizationId = '527d8278-0000-4000-8000-0000000c0de1';
const gitlabRef: ProviderPrRef = {
  platform: 'gitlab',
  projectPath: 'sample/review-copy',
  mrIid: 1,
};

const memberships = [
  {
    organizationId,
    organizationName: 'Acme',
    parentOrganizationId: null,
    role: 'member',
    memberCount: 3,
    balance: 0,
    requireSeats: false,
    plan: 'teams',
    created_at: '2026-01-01T00:00:00.000Z',
    isTrialExpiredForEnforcement: false,
    seatCount: { used: 1, total: 3 },
    inheritedChildren: [],
  },
] satisfies inferRouterOutputs<MobileRouter>['organizations']['list'];

/** The row an unhealthy GitLab integration answers with: it needs re-authorizing. */
const gitlabReconnectStatus = {
  connected: false,
  reconnectRequired: true,
  integration: null,
} satisfies inferRouterOutputs<MobileRouter>['organizations']['reviewAgent']['getGitLabStatus'];

function fixtureResponse(data: unknown): Response {
  // eslint-disable-next-line unicorn/prefer-response-static-json -- React Native's fetch polyfill has no static Response.json.
  return new Response(JSON.stringify({ result: { data } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A read failure in the shape the tRPC http link raises as its error. */
function readFailure(path: string): Response {
  const body = JSON.stringify({
    error: {
      message: 'The connection status could not be read',
      code: -32603,
      data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500, path, stack: '' },
    },
  });
  return new Response(body, {
    status: 500,
    headers: { 'content-type': 'application/json' },
  });
}

function createFixtureClient(surface: PrReviewGateFixtureSurface) {
  return createTRPCClient<MobileRouter>({
    links: [
      httpLink({
        // The fixture never reaches the network: the fetch below answers every
        // read, so this marker only names which client answered it.
        url: 'review-gate-fixture-trpc',
        fetch: async (input, init) => {
          await Promise.resolve();
          const url = input instanceof Request ? input.url : input.toString();
          if (init?.method !== 'GET') {
            throw new Error('Review gate fixture does not allow writes');
          }
          if (url.includes('/githubApps.getUserAuthorization')) {
            return surface === 'gate-github-error'
              ? readFailure('githubApps.getUserAuthorization')
              : fixtureResponse({ connected: true, revoked: false });
          }
          if (url.includes('/organizations.reviewAgent.getGitLabStatus')) {
            return surface === 'gate-gitlab-error'
              ? readFailure('organizations.reviewAgent.getGitLabStatus')
              : fixtureResponse(gitlabReconnectStatus);
          }
          if (url.includes('/organizations.reviewAgent.getBitbucketReadiness')) {
            return readFailure('organizations.reviewAgent.getBitbucketReadiness');
          }
          if (url.includes('/organizations.list')) {
            return fixtureResponse(memberships);
          }
          throw new Error('Read not provided by the review gate fixture');
        },
      }),
    ],
  });
}

export function PrReviewGateCopyFixture({
  surface,
}: Readonly<{ surface: PrReviewGateFixtureSurface }>) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
        mutationCache: new MutationCache({
          onMutate: () => {
            throw new Error('Review gate fixture does not allow writes');
          },
        }),
      })
  );
  const [client] = useState(() => createFixtureClient(surface));
  const content =
    surface === 'gate-github-error' ? (
      <PrReviewConnectGate prRef={{ platform: 'github', ...triple }}>
        <View />
      </PrReviewConnectGate>
    ) : (
      <PrReviewConnectGate
        platform={surface === 'gate-bitbucket-error' ? 'bitbucket' : 'gitlab'}
        organizationId={organizationId}
        prRef={gitlabRef}
      >
        <View />
      </PrReviewConnectGate>
    );
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={client} queryClient={queryClient}>
        {content}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
