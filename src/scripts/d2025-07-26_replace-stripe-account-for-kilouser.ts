import { createStripeCustomer } from '@/lib/stripe-client';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

async function createStripeCustomerForUser(kiloUserId: string) {
  console.log(`Looking up user with ID: ${kiloUserId}`);

  const user = await db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, kiloUserId),
  });

  if (!user) {
    console.error(`User not found with ID: ${kiloUserId}`);
    process.exit(1);
  }

  console.log(`Found user: ${user.google_user_name} (${user.google_user_email})`);
  console.log(`Current Stripe Customer ID: ${user.stripe_customer_id}`);

  const oldStripeCustomerId = user.stripe_customer_id;

  console.log('Creating new Stripe customer...');
  const stripeCustomer = await createStripeCustomer({
    email: user.google_user_email,
    name: user.google_user_name,
    metadata: { kiloUserId: user.id },
  });

  console.log(`New Stripe Customer ID: ${stripeCustomer.id}`);

  console.log('Updating database...');
  await db
    .update(kilocode_users)
    .set({ stripe_customer_id: stripeCustomer.id })
    .where(eq(kilocode_users.id, kiloUserId));

  console.log('Database updated successfully!');

  console.log('\n=== SUMMARY ===');
  console.log(`User ID: ${kiloUserId}`);
  console.log(`User Email: ${user.google_user_email}`);
  console.log(`User Name: ${user.google_user_name}`);
  console.log(`OLD Stripe Customer ID: ${oldStripeCustomerId}`);
  console.log(`NEW Stripe Customer ID: ${stripeCustomer.id}`);
}

createStripeCustomerForUser(process.argv[2])
  .then(() => {
    console.log('Script completed successfully!');
    process.exit(0);
  })
  .catch(error => {
    console.error('Script failed:', error);
    process.exit(1);
  });
