import { describe, expect, test } from '@jest/globals';

import type Stripe from 'stripe';

/**
 * The personal invoice page reuses the organization page's Stripe source and
 * shape, so these tests drive the procedure against the same Stripe client
 * double `lib/stripe/index.test.ts` uses for
 * `getStripeInvoicesPage`-style coverage: a spy on `client.invoices.list`.
 *
 * The procedure itself reads no database rows, so a caller context carrying
 * only the signed-in user is enough.
 */
function contextFor(stripeCustomerId: string | null) {
  return {
    user: { stripe_customer_id: stripeCustomerId },
    headersList: new Headers(),
  };
}

const PAGE_INVOICES = [
  {
    id: 'in_personal_1',
    object: 'invoice',
    number: 'KILO-1',
    status: 'paid',
    amount_due: 2_000,
    currency: 'usd',
    created: 1_700_000_000,
    hosted_invoice_url: 'https://invoice.stripe.test/in_personal_1',
    invoice_pdf: 'https://invoice.stripe.test/in_personal_1.pdf',
    lines: { data: [{ description: 'Credit purchase' }] },
  },
] as unknown as Stripe.Invoice[];

describe('user.invoicesPage', () => {
  test('returns an empty page for a caller with no Stripe customer', async () => {
    jest.resetModules();
    await jest.isolateModulesAsync(async () => {
      const { createCallerFactory } = await import('@kilocode/web-shared/lib/trpc/init');
      const { userRouter } = await import('@/routers/user-router');
      const caller = createCallerFactory(userRouter)(contextFor(null) as never);

      await expect(caller.invoicesPage({})).resolves.toEqual({
        entries: [],
        hasMore: false,
        nextCursor: null,
      });
    });
  });

  test('pages the caller’s own invoices and forwards the cursor', async () => {
    jest.resetModules();
    await jest.isolateModulesAsync(async () => {
      const { client } = await import('@kilocode/web-shared/lib/stripe-client');
      const listSpy = jest.spyOn(client.invoices, 'list').mockResolvedValue({
        data: PAGE_INVOICES,
        has_more: true,
      } as unknown as Awaited<ReturnType<typeof client.invoices.list>>);

      const { createCallerFactory } = await import('@kilocode/web-shared/lib/trpc/init');
      const { userRouter } = await import('@/routers/user-router');
      const caller = createCallerFactory(userRouter)(contextFor('cus_personal') as never);

      const page = await caller.invoicesPage({ period: 'year', cursor: 'in_cursor' });

      const [listParams] = listSpy.mock.calls[0] ?? [];
      expect(listParams).toMatchObject({
        customer: 'cus_personal',
        limit: 25,
        starting_after: 'in_cursor',
      });
      expect(listParams?.created).toEqual({ gte: expect.any(Number) });
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).toBe('in_personal_1');
      expect(page.entries).toEqual([
        expect.objectContaining({
          id: 'in_personal_1',
          number: 'KILO-1',
          status: 'paid',
          amount_due: 2_000,
          currency: 'usd',
          invoice_pdf: 'https://invoice.stripe.test/in_personal_1.pdf',
          hosted_invoice_url: 'https://invoice.stripe.test/in_personal_1',
          description: 'Credit purchase',
        }),
      ]);

      listSpy.mockRestore();
    });
  });
});
