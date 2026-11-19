import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTRPCClient, httpLink } from '@trpc/client';
import { useState } from 'react';

import { PersonalInvoicesScreen } from '@/components/personal-invoices-screen';
import { TRPCProvider } from '@/lib/trpc';

// In a development build, open dev/personal-invoices-fixture/<state> through the
// app's native link scheme. The app's selected language applies.
//
// The personal invoices list is a Stripe read served by the backend, and a local
// stack has no Stripe customer to list, so this fixture answers the one read the
// real screen makes instead of seeding a customer. `listed` serves one page of
// rows with every status the list colors; `empty` serves the settled empty page.
// The screen and its pagination hook are the production ones, and the DTOs cross
// the usual tRPC boundary. Reads never touch the network, and the mutation cache
// rejects before any mutation function runs.

type RouterOutputs = inferRouterOutputs<MobileRouter>;
type InvoicesPage = RouterOutputs['user']['invoicesPage'];

type PersonalInvoicesFixtureState = 'listed' | 'empty';

/**
 * Sample rows. Each `created` is noon UTC on the day its description names: the
 * screen formats it in the device's own zone, so a midnight value would print
 * the last day of the previous month anywhere west of UTC.
 */
const INVOICES: InvoicesPage['entries'] = [
  {
    id: 'in_personal_fixture_paid',
    number: 'INV-2026-0002',
    status: 'paid',
    amount_due: 1000,
    currency: 'usd',
    created: Date.parse('2026-05-01T12:00:00Z') / 1000,
    hosted_invoice_url: 'https://billing.example.com/in_personal_fixture_paid',
    invoice_pdf: 'https://billing.example.com/in_personal_fixture_paid.pdf',
    invoice_type: 'topup',
    description: '$10.00 credit pack',
  },
  {
    id: 'in_personal_fixture_void',
    number: 'INV-2026-0001',
    status: 'void',
    amount_due: 0,
    currency: 'usd',
    created: Date.parse('2026-04-01T12:00:00Z') / 1000,
    hosted_invoice_url: null,
    invoice_pdf: null,
    invoice_type: 'seats',
    description: 'Kilo Pass',
  },
];

const EMPTY_PAGE: InvoicesPage = { entries: [], hasMore: false, nextCursor: null };

function fixtureResponse(data: InvoicesPage): Response {
  // eslint-disable-next-line unicorn/prefer-response-static-json -- React Native's fetch polyfill has no static Response.json.
  return new Response(JSON.stringify({ result: { data } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function createFixtureClient(state: { readonly value: PersonalInvoicesFixtureState }) {
  return createTRPCClient<MobileRouter>({
    links: [
      httpLink({
        url: 'http://personal-invoices-fixture.invalid/api/trpc',
        fetch: async (input, init) => {
          await Promise.resolve();
          const url = input instanceof Request ? input.url : input.toString();
          if (init?.method !== 'GET') {
            throw new Error('Personal invoices fixture does not allow writes');
          }
          if (url.includes('/user.invoicesPage')) {
            return fixtureResponse(
              state.value === 'listed' ? { ...EMPTY_PAGE, entries: INVOICES } : EMPTY_PAGE
            );
          }
          throw new Error('Read not provided by the personal invoices fixture');
        },
      }),
    ],
  });
}

export function PersonalInvoicesFixture({ state }: { state: PersonalInvoicesFixtureState }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
        mutationCache: new MutationCache({
          onMutate: () => {
            throw new Error('Personal invoices fixture does not allow writes');
          },
        }),
      })
  );
  const [client] = useState(() => createFixtureClient({ value: state }));

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={client} queryClient={queryClient}>
        <PersonalInvoicesScreen />
      </TRPCProvider>
    </QueryClientProvider>
  );
}
