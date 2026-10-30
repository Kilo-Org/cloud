import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTRPCClient, httpLink } from '@trpc/client';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { OrganizationInvoicesScreen } from '@/components/organization/invoices-screen';
import { Text } from '@/components/ui/text';
import { useOrganization } from '@/lib/organization-context';
import { TRPCProvider } from '@/lib/trpc';

// In a development build, open dev/organization-invoices-fixture through the
// app's native link scheme. The app's selected language applies.
//
// The invoices list is a Stripe read served by the backend, and a local stack
// has no Stripe customer to list, so this fixture answers the two reads the real
// screen makes instead of seeding a customer: the membership list for the
// selected organization and one page of invoices. The rows hold the three
// statuses the list colors, so the status pill renders its paid, open and void
// states on one page. The screen, its pagination hook and the row layout are the
// production ones, and the DTOs cross the usual tRPC boundary. Reads never touch
// the network, and the mutation cache rejects before any mutation function runs.
//
// Select an organization in the app first: the boundary the screen reads takes
// its id from the app's choice, and the fixture repeats that id back in the list.

type RouterOutputs = inferRouterOutputs<MobileRouter>;
type InvoicesPage = RouterOutputs['organizations']['invoicesPage'];
type OrganizationList = RouterOutputs['organizations']['list'];
type FixtureReadData = InvoicesPage | OrganizationList;

const INVOICES: InvoicesPage['entries'] = [
  {
    id: 'in_fixture_open',
    number: 'INV-2026-0003',
    status: 'open',
    amount_due: 4900,
    currency: 'usd',
    created: 1_767_225_600,
    hosted_invoice_url: 'https://billing.example.com/in_fixture_open',
    invoice_pdf: null,
    invoice_type: 'seats',
    description: 'Kilo Pass seats, June 2026',
  },
  {
    id: 'in_fixture_paid',
    number: 'INV-2026-0002',
    status: 'paid',
    amount_due: 4900,
    currency: 'usd',
    created: 1_764_547_200,
    hosted_invoice_url: 'https://billing.example.com/in_fixture_paid',
    invoice_pdf: 'https://billing.example.com/in_fixture_paid.pdf',
    invoice_type: 'seats',
    description: 'Kilo Pass seats, May 2026',
  },
  {
    id: 'in_fixture_void',
    number: 'INV-2026-0001',
    status: 'void',
    amount_due: 1900,
    currency: 'usd',
    created: 1_761_868_800,
    hosted_invoice_url: null,
    invoice_pdf: null,
    invoice_type: 'topup',
    description: 'Top-up',
  },
];

function fixtureResponse(data: FixtureReadData): Response {
  // eslint-disable-next-line unicorn/prefer-response-static-json -- React Native's fetch polyfill has no static Response.json.
  return new Response(JSON.stringify({ result: { data } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * One membership row for the selected organization, shaped like the router's
 * real answer. The screen only reads `organizationId` and `role`; the rest keeps
 * the DTO honest.
 */
function organizationEntry(organizationId: string): OrganizationList[number] {
  return {
    organizationId,
    organizationName: 'Invoices fixture org',
    role: 'owner',
    memberCount: 3,
    balance: 0,
    requireSeats: true,
    plan: 'teams',
    created_at: '2026-01-01T00:00:00.000Z',
    seatCount: { used: 5, total: 5 },
    inheritedChildren: [],
  };
}

/**
 * Answers the reads with the selected organization, read at request time so the
 * fixture follows the app's choice instead of freezing the first render.
 */
function createFixtureClient(selected: { readonly organizationId: string | null }) {
  return createTRPCClient<MobileRouter>({
    links: [
      httpLink({
        url: 'http://organization-invoices-fixture.invalid/api/trpc',
        fetch: async (input, init) => {
          await Promise.resolve();
          const url = input instanceof Request ? input.url : input.toString();
          if (init?.method !== 'GET') {
            throw new Error('Organization invoices fixture does not allow writes');
          }
          if (url.includes('/organizations.invoicesPage')) {
            return fixtureResponse({ entries: INVOICES, hasMore: false, nextCursor: null });
          }
          if (url.includes('/organizations.list')) {
            const organizationId = selected.organizationId;
            return fixtureResponse(
              organizationId === null ? [] : [organizationEntry(organizationId)]
            );
          }
          throw new Error('Read not provided by the organization invoices fixture');
        },
      }),
    ],
  });
}

export function OrganizationInvoicesFixture() {
  const { t } = useTranslation();
  const { organizationId } = useOrganization();
  const selected = useState(() => ({ organizationId }))[0];
  selected.organizationId = organizationId;
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
        mutationCache: new MutationCache({
          onMutate: () => {
            throw new Error('Organization invoices fixture does not allow writes');
          },
        }),
      })
  );
  const [client] = useState(() => createFixtureClient(selected));

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={client} queryClient={queryClient}>
        <View className="flex-1 bg-background">
          {organizationId === null ? (
            <View className="flex-1 items-center justify-center px-6">
              <Text className="text-center text-sm text-muted-foreground">
                {t('organization.boundary.selectOrganization')}
              </Text>
            </View>
          ) : (
            <OrganizationInvoicesScreen />
          )}
        </View>
      </TRPCProvider>
    </QueryClientProvider>
  );
}
