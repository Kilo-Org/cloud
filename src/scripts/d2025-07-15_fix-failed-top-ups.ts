import { kilocode_users, user_admin_notes } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { grantCreditForCategory } from '@/lib/promotionalCredits';
import { client } from '@/lib/stripe-client';
import { findUserByStripeCustomerId } from '@/lib/user';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';

const eventIDs = [
  'evt_3RlBM0J7A6SsvrfS0XudYbZY',
  'evt_3RlBR2J7A6SsvrfS0qHqxzsF',
  'evt_3RlBUYJ7A6SsvrfS1TM5JfB2',
  'evt_3RlBaZJ7A6SsvrfS0MoH8zU3',
  'evt_3RlBcAJ7A6SsvrfS1ioWyYbB',
  'evt_3RlBdYJ7A6SsvrfS1LInaSRk',
  'evt_3RlBeqJ7A6SsvrfS0fAeqwbh',
  'evt_3RlBgTJ7A6SsvrfS1Nia93yZ',
  'evt_3RlBiSJ7A6SsvrfS0DcHXZuP',
  'evt_3RlBiEJ7A6SsvrfS1ZybtTtp',
  'evt_3RlBl9J7A6SsvrfS1N2ULetF',
  'evt_3RlBogJ7A6SsvrfS0eFisKUW',
  'evt_3RlBuSJ7A6SsvrfS03DwHQ7h',
  'evt_3RlBu8J7A6SsvrfS1RJZOFDh',
  'evt_3RlBveJ7A6SsvrfS11nB5qby',
  'evt_3RlC3QJ7A6SsvrfS1gNhuK5W',
  'evt_3RlC8IJ7A6SsvrfS1u3MeYQO',
  'evt_3RlCHPJ7A6SsvrfS1isPJblm',
  'evt_3RlCHpJ7A6SsvrfS1VicdsNH',
  'evt_3RlCHcJ7A6SsvrfS0ziHM0Ft',
  'evt_3RlCIBJ7A6SsvrfS00wRaCHz',
  'evt_3RlCIgJ7A6SsvrfS0qi4fssV',
  'evt_3RlCQ3J7A6SsvrfS1ezlGBZI',
  'evt_3RlCTcJ7A6SsvrfS11mLZEyy',
  'evt_3RlCVzJ7A6SsvrfS0aDoG3gC',
  'evt_3RlCaAJ7A6SsvrfS1fNpng5R',
  'evt_3RlCfTJ7A6SsvrfS1q5y6lhC',
  'evt_3RlCgKJ7A6SsvrfS1fzXbVOJ',
  'evt_3RlCh7J7A6SsvrfS10NMArHP',
  'evt_3RlChIJ7A6SsvrfS0eeaVqtV',
  'evt_3RlCl2J7A6SsvrfS0bITN3nK',
  'evt_3RlCmQJ7A6SsvrfS14l8gCPY',
  'evt_3RlCnVJ7A6SsvrfS0cVU2Tj1',
  'evt_3RlCpjJ7A6SsvrfS0BBPvolL',
  'evt_3RlD9SJ7A6SsvrfS07YrqNcB',
  'evt_3RlDAlJ7A6SsvrfS1aVtLHdo',
  'evt_3RlDB5J7A6SsvrfS1Tzg5VTl',
  'evt_3RlDGLJ7A6SsvrfS1JxRgekw',
  'evt_3RlDFwJ7A6SsvrfS1l9rNwCt',
  'evt_3RlDHpJ7A6SsvrfS1Gt70sPK',
  'evt_3RlDPzJ7A6SsvrfS1u4yal7O',
  'evt_3RlDQ0J7A6SsvrfS0ZhGOwOm',
  'evt_3RlDVcJ7A6SsvrfS0PxuqHTp',
  'evt_3RlDVZJ7A6SsvrfS1O40BwJM',
  'evt_3RlDXbJ7A6SsvrfS0rX6QZVP',
  'evt_3RlDekJ7A6SsvrfS0SRzXW1i',
  'evt_3RlDkNJ7A6SsvrfS0BXkF893',
  'evt_3RlDl3J7A6SsvrfS1p2oWRal',
];

export async function fixFailedTopUps() {
  const uniqueCustomerIDs = new Set<string>();

  const adminUser = await db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.google_user_email, 'remon@kilocode.ai'),
  });

  if (!adminUser) {
    console.error('Admin user not found, cannot proceed with credit granting.');
    return;
  }

  for (const eventId of eventIDs) {
    try {
      const event = await client.events.retrieve(eventId);
      const charge = event.data.object as Stripe.Charge;

      if (charge.status !== 'succeeded') {
        console.warn(`Charge ${eventId} is not succeeded, skipping.`);
        continue;
      }

      // Refund the payment
      const refund = await client.refunds.create({
        payment_intent: charge.payment_intent as string,
      });

      console.info(`Refunded charge ${eventId}:`, refund.id);

      uniqueCustomerIDs.add(charge.customer as string);
    } catch (error) {
      console.error(`Error processing charge ${eventId}:`, error);
    }
  }

  console.info(
    `Processed ${eventIDs.length} events, found ${uniqueCustomerIDs.size} unique customers.`
  );

  for (const customerId of uniqueCustomerIDs) {
    const user = await findUserByStripeCustomerId(customerId);

    if (!user) {
      console.warn(`User with Stripe customer ID ${customerId} not found.`);
      continue;
    }

    await grantCreditForCategory(user, {
      amount_usd: 30,
      description: `Recovery for failed top-up credit 15-7-2025`,
      credit_category: 'custom',
      counts_as_selfservice: false,
    });

    await db.insert(user_admin_notes).values({
      kilo_user_id: user.id,
      note_content: `Recovery for failed top-up credit 15-7-2025`,
      admin_kilo_user_id: adminUser.id,
    });

    console.info(
      `Granted credit to user ${user.id} (${user.google_user_email}) for customer ID ${customerId}.`
    );
  }

  console.info(`Processed ${uniqueCustomerIDs.size} unique customers.`);
}

void fixFailedTopUps();
