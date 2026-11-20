import {
  createKiloclawInstance,
  makeStripeSubscription,
  stripeMock,
  user,
} from './kiloclaw-billing-router.test-harness';
import { describe, expect, it, beforeAll } from '@jest/globals';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { kiloclaw_subscriptions, credit_transactions } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { CURRENT_KILOCLAW_PRICE_VERSION } from '@kilocode/db';

describe('current-price canceled Stripe checkout webhook ordering', () => {
  let handleKiloClawSubscriptionCreated: (params: {
    eventId: string;
    subscription: Stripe.Subscription;
  }) => Promise<void>;
  let handleKiloClawInvoicePaid: (params: {
    eventId: string;
    invoice: Stripe.Invoice;
  }) => Promise<void>;

  beforeAll(async () => {
    const mod = await import('@/lib/kiloclaw/stripe-handlers');
    handleKiloClawSubscriptionCreated = mod.handleKiloClawSubscriptionCreated;
    handleKiloClawInvoicePaid = mod.handleKiloClawInvoicePaid;
  });

  it.each(['subscription.created before invoice.paid', 'invoice.paid before subscription.created'])(
    'settles safely when %s',
    async order => {
      const orderKey = order.startsWith('subscription.created') ? 'created_first' : 'invoice_first';
      const instance = await createKiloclawInstance(user.id);
      await db.insert(kiloclaw_subscriptions).values({
        user_id: user.id,
        instance_id: instance.id,
        stripe_subscription_id: `sub_deleted_old_${orderKey}`,
        payment_source: 'credits',
        plan: 'standard',
        status: 'canceled',
        kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      });

      const stripeSubscriptionId = `sub_current_rejoin_${orderKey}`;
      const subscription = makeStripeSubscription({
        id: stripeSubscriptionId,
        metadata: {
          type: 'kiloclaw',
          billingContext: 'personal',
          plan: 'standard',
          kiloUserId: user.id,
          instanceId: instance.id,
          kiloclawPriceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
        },
        status: 'active',
        priceId: 'price_current_standard',
      });
      stripeMock.subscriptions.retrieve.mockResolvedValue({
        ...subscription,
        schedule: null,
      });
      const invoice = {
        id: `in_current_rejoin_${orderKey}`,
        amount_paid: 5_500,
        currency: 'usd',
        charge: `ch_current_rejoin_${orderKey}`,
        parent: {
          subscription_details: {
            subscription: stripeSubscriptionId,
          },
        },
        lines: {
          data: [
            {
              pricing: {
                price_details: {
                  price: 'price_current_standard',
                },
              },
              period: {
                start: Math.floor(new Date('2026-06-10T15:03:00.000Z').getTime() / 1000),
                end: Math.floor(new Date('2026-07-10T15:03:00.000Z').getTime() / 1000),
              },
            },
          ],
        },
      } as unknown as Stripe.Invoice;

      if (order.startsWith('subscription.created')) {
        await handleKiloClawSubscriptionCreated({
          eventId: `evt_created_${orderKey}`,
          subscription,
        });
        await handleKiloClawInvoicePaid({
          eventId: `evt_invoice_${orderKey}`,
          invoice,
        });
      } else {
        await handleKiloClawInvoicePaid({
          eventId: `evt_invoice_${orderKey}`,
          invoice,
        });
        await handleKiloClawSubscriptionCreated({
          eventId: `evt_created_${orderKey}`,
          subscription,
        });
      }

      const [row] = await db
        .select()
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.instance_id, instance.id));
      expect(row).toEqual(
        expect.objectContaining({
          status: 'active',
          payment_source: 'credits',
          plan: 'standard',
          kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
          stripe_subscription_id: stripeSubscriptionId,
        })
      );

      const settlementEntries = await db
        .select()
        .from(credit_transactions)
        .where(eq(credit_transactions.kilo_user_id, user.id));
      expect(
        settlementEntries.map(entry => entry.amount_microdollars).sort((a, b) => a - b)
      ).toEqual([-55_000_000, 55_000_000]);
    }
  );
});
